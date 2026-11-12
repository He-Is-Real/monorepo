import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  Param,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { PersonSessions } from '@heisreal/auth';
import { DatabaseQueryError, runQuery, SURREAL } from '@heisreal/database';
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
}

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
 * is never blocked. Entries are permanent until an Admin removes them, and hold only who added
 * them and when. Adding something already listed changes nothing (it keeps its first adder).
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
      `SELECT email AS value, addedBy ?? NULL AS addedBy, addedAt FROM blockedEmail
         ORDER BY addedAt DESC, value ASC;
       SELECT ip AS value, addedBy ?? NULL AS addedBy, addedAt FROM blockedIp
         ORDER BY addedAt DESC, value ASC;`,
    )) as [Row[], Row[]];
    const shape = (key: 'email' | 'ip') => (r: Row) => ({
      [key]: r.value,
      addedBy: r.addedBy ?? null,
      addedAt: new Date(r.addedAt).toISOString(),
    });
    return { emails: emails.map(shape('email')), ips: ips.map(shape('ip')) };
  }

  /** BlockEmail: it can't create an account or send a story, until an Admin removes it. */
  @Put('emails/:email')
  @RequiresRole('Admin')
  blockEmail(@Req() req: Request, @Param('email') raw: string) {
    return this.add(req, 'emails', raw);
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
  blockIp(@Req() req: Request, @Param('ip') raw: string) {
    return this.add(req, 'ips', raw);
  }

  /** UnblockIp: off the list (whether or not it was on it). */
  @Delete('ips/:ip')
  @RequiresRole('Admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unblockIp(@Param('ip') raw: string) {
    await this.remove('ips', raw);
  }

  private async add(req: Request, kind: Kind, raw: string) {
    const value = listValue(kind, raw);
    const { email: by } = await this.people.authenticate(req);
    try {
      await runQuery(
        this.db,
        `IF (SELECT VALUE id FROM ONLY type::record($table, $value)) = NONE {
           CREATE type::record($table, $value)
             CONTENT { ${FIELD[kind]}: $value, addedBy: $by } RETURN NONE;
         };`,
        { table: TABLE[kind], value, by: by ?? undefined },
      );
    } catch (err) {
      // The database's own check of the value (`string::is_email`) is the last word.
      if (err instanceof DatabaseQueryError && /conform/.test(err.message)) {
        throw kind === 'emails' ? badEmail() : badIp();
      }
      throw err;
    }
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
