import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  Param,
  Patch,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { PersonSessions } from '@heisreal/auth';
import {
  DatabaseQueryError,
  retryOnConflict,
  runQuery,
  SURREAL,
} from '@heisreal/database';
import { canonicalIp, ProblemException } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';

/** The two lists: emails and IP addresses (`blockedEmail`, `blockedIp`). */
type Kind = 'emails' | 'ips';
const TABLE: Record<Kind, 'blockedEmail' | 'blockedIp'> = {
  emails: 'blockedEmail',
  ips: 'blockedIp',
};
const FIELD: Record<Kind, 'email' | 'ip'> = { emails: 'email', ips: 'ip' };

/** Roughly what the database's `string::is_email` takes; the database has the last word. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Row {
  value: string;
  addedBy: string | null;
  addedAt: string;
  note: string | null;
}

/** A note's longest length, in characters (BN-2, Joel 2026-11-22). */
export const NOTE_MAX = 500;

const invalid = (pointer: string, code: string, message: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    [{ pointer, code, message }],
  );
const badEmail = () =>
  invalid('/email', 'blocked_email', 'Enter an email address.');
const badIp = () =>
  invalid(
    '/ip',
    'blocked_ip',
    'Enter an IP address, like 203.0.113.7 or 2001:db8::1.',
  );

/**
 * Trims a note exactly as the database's `string::trim` does: Unicode White_Space at either end
 * (U+0085 too; JavaScript's own trim() misses it and also strips U+FEFF, which the database keeps).
 */
const trimNote = (text: string) =>
  text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

const badNote = (message: string) => invalid('/note', 'block_note', message);
const tooLong = () =>
  badNote(`Keep the note to ${NOTE_MAX} characters or fewer.`);

/** A note's value: text (trimmed, at most 500 characters) or `null`/blank, which is no note. */
function noteValue(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') throw badNote('The note is text.');
  const note = trimNote(value);
  if ([...note].length > NOTE_MAX) throw tooLong();
  return note || undefined;
}

const isObject = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body);

/** Only `note` (BlockNote has additionalProperties: false). */
function onlyNote(body: Record<string, unknown>): void {
  const extra = Object.keys(body).find((k) => k !== 'note');
  if (extra !== undefined) {
    throw invalid(`/${extra}`, 'unexpected', 'Only a note can be sent.');
  }
}

/**
 * Blocking's optional body (BN-2): `{ note }`. A missing body, or a missing, `null` or blank note,
 * is no note (`undefined`).
 */
function parseBlockNote(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (!isObject(body)) throw invalid('', 'body', 'The body is an object.');
  onlyNote(body);
  return body['note'] === undefined ? undefined : noteValue(body['note']);
}

/**
 * A note change, JSON Merge Patch (D28): the body is required. An omitted `note` leaves it as it is
 * (`unchanged`); `null` or blank clears it (`undefined`); otherwise the new note.
 */
const UNCHANGED = Symbol('unchanged');
function parseNotePatch(body: unknown): string | undefined | typeof UNCHANGED {
  if (!isObject(body)) throw invalid('', 'body', 'The body is an object.');
  onlyNote(body);
  return 'note' in body ? noteValue(body['note']) : UNCHANGED;
}

/** The database refused the note (its own check is the last word): the usual 400, nothing logged. */
const isNoteRefusal = (err: unknown) =>
  err instanceof DatabaseQueryError &&
  /conform/.test(err.message) &&
  /field `note`/.test(err.message);

const notListed = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    'It isn’t on the block list.',
  );

/** The path's value in the form the list keeps it (lower-case; an IP's one form), or 400. */
function listValue(kind: Kind, raw: string): string {
  const text = String(raw ?? '').trim();
  if (kind === 'ips') {
    const ip = canonicalIp(text);
    if (!ip) throw badIp();
    return ip;
  }
  const email = text.toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw badEmail();
  return email;
}

/**
 * api-admin.yaml, tag BlockList (G21 D, G24; Joel 2026-11-11; m3-plan-and-m2-extras.html, "Block
 * list"): the block list at /admin/block-list, Admins only (D1). A blocked email can't create an
 * account or send a story; a blocked IP address can't send a story (api-user checks both); reading
 * is never blocked. Entries are permanent until an Admin removes them, and hold who added them,
 * when, and an optional note on why (BN-1 to BN-7, Joel 2026-11-22), which any Admin may change
 * later. Adding something already listed changes nothing (it keeps its first adder and note).
 */
@Controller('v1/admin/block-list')
export class BlockListController {
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    private readonly people: PersonSessions,
  ) {}

  @Get()
  @RequiresRole('Admin')
  async list(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'private, no-store');
    const [emails, ips] = (await runQuery(
      this.db,
      `SELECT email AS value, addedBy ?? NULL AS addedBy, addedAt, note ?? NULL AS note
         FROM blockedEmail ORDER BY addedAt DESC, value ASC;
       SELECT ip AS value, addedBy ?? NULL AS addedBy, addedAt, note ?? NULL AS note
         FROM blockedIp ORDER BY addedAt DESC, value ASC;`,
    )) as [Row[], Row[]];
    const shape = (key: 'email' | 'ip') => (r: Row) => ({
      [key]: r.value,
      addedBy: r.addedBy ?? null,
      addedAt: new Date(r.addedAt).toISOString(),
      note: r.note ?? null,
    });
    return { emails: emails.map(shape('email')), ips: ips.map(shape('ip')) };
  }

  /** BlockEmail: it can't create an account or send a story, until an Admin removes it. */
  @Put('emails/:email')
  @RequiresRole('Admin')
  blockEmail(
    @Req() req: Request,
    @Param('email') raw: string,
    @Body() body: unknown,
  ) {
    return this.add(req, 'emails', raw, body);
  }

  /** ChangeEmailNote (BN-4 A): sets or clears its note. */
  @Patch('emails/:email')
  @RequiresRole('Admin')
  changeEmailNote(@Param('email') raw: string, @Body() body: unknown) {
    return this.changeNote('emails', raw, body);
  }

  /** UnblockEmail: off the list (whether or not it was on it). */
  @Delete('emails/:email')
  @RequiresRole('Admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unblockEmail(@Param('email') raw: string) {
    await this.remove('emails', raw);
  }

  /** BlockIp: it can't send a story, until an Admin removes it. */
  @Put('ips/:ip')
  @RequiresRole('Admin')
  blockIp(
    @Req() req: Request,
    @Param('ip') raw: string,
    @Body() body: unknown,
  ) {
    return this.add(req, 'ips', raw, body);
  }

  /** ChangeIpNote (BN-4 A): sets or clears its note. */
  @Patch('ips/:ip')
  @RequiresRole('Admin')
  changeIpNote(@Param('ip') raw: string, @Body() body: unknown) {
    return this.changeNote('ips', raw, body);
  }

  /** UnblockIp: off the list (whether or not it was on it). */
  @Delete('ips/:ip')
  @RequiresRole('Admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unblockIp(@Param('ip') raw: string) {
    await this.remove('ips', raw);
  }

  private async add(req: Request, kind: Kind, raw: string, body: unknown) {
    const value = listValue(kind, raw);
    const note = parseBlockNote(body);
    const { email: by } = await this.people.authenticate(req);
    try {
      await retryOnConflict(() =>
        runQuery(
          this.db,
          `IF (SELECT VALUE id FROM ONLY type::record($table, $value)) = NONE {
             CREATE type::record($table, $value)
               CONTENT { ${FIELD[kind]}: $value, addedBy: $by, note: $note } RETURN NONE;
           };`,
          { table: TABLE[kind], value, by: by ?? undefined, note },
        ),
      );
    } catch (err) {
      if (isNoteRefusal(err)) throw tooLong();
      // The database's own check of the value (`string::is_email`) is the last word.
      if (err instanceof DatabaseQueryError && /conform/.test(err.message)) {
        throw kind === 'emails' ? badEmail() : badIp();
      }
      // Another Admin added the same one at the same moment: it's on the list either way.
      if (!(
        err instanceof DatabaseQueryError && /already exists/.test(err.message)
      )) {
        throw err;
      }
    }
    return { id: value, version: null };
  }

  /** The later save wins (no version check; BN-4 A keeps no record of who changed it). */
  private async changeNote(kind: Kind, raw: string, body: unknown) {
    const value = listValue(kind, raw);
    const note = parseNotePatch(body);
    const query =
      note === UNCHANGED
        ? `SELECT VALUE id FROM type::record($table, $value);`
        : `UPDATE type::record($table, $value) SET note = $note RETURN VALUE id;`;
    let changed: unknown[];
    try {
      [changed] = (await runQuery(this.db, query, {
        table: TABLE[kind],
        value,
        note: note === UNCHANGED ? undefined : note,
      })) as [unknown[]];
    } catch (err) {
      if (isNoteRefusal(err)) throw tooLong();
      throw err;
    }
    if (changed.length === 0) throw notListed();
    return { id: value, version: null };
  }

  private async remove(kind: Kind, raw: string) {
    await runQuery(this.db, `DELETE type::record($table, $value);`, {
      table: TABLE[kind],
      value: listValue(kind, raw),
    });
  }
}

@Module({ controllers: [BlockListController] })
export class BlockListModule {}
