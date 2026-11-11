import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  Param,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { PersonSessions } from '@heisreal/auth';
import {
  DatabaseQueryError,
  isTransactionConflict,
  retryOnConflict,
  runQuery,
  SURREAL,
} from '@heisreal/database';
import { ProblemException } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import { SecretsService } from '@heisreal/secrets';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';
import baseline from './baseline-admins.json';
import {
  createStaffClerk,
  STAFF_CLERK,
  type StaffClerk,
  type StaffRole,
} from './staff-clerk';

const STAFF_ROLES: readonly StaffRole[] = ['Moderator', 'Admin'];
/** G7 (Joel, 2026-11-11): "just enforce @heisreal.today domain emails only". */
const STAFF_EMAIL = /^[a-z0-9._%+-]+@heisreal\.today$/;

/** The baseline admins (S-4), from `baseline-admins.json`, lower-case. */
export const BASELINE_ADMINS: readonly string[] = baseline.admins.map((e) =>
  e.toLowerCase(),
);
for (const email of BASELINE_ADMINS) {
  if (!STAFF_EMAIL.test(email)) {
    throw new Error(`baseline-admins.json: not a staff email: ${email}`);
  }
}

/** What a change did to the list. */
export type StaffChange = 'added' | 'changed' | 'removed' | 'unchanged';

/** A change's outcome: what it did to the list, and how many Clerk accounts have the email. */
export interface StaffOutcome {
  change: StaffChange;
  accounts: number;
}

interface StaffRow {
  email: string;
  role: StaffRole;
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

/**
 * 400: no Clerk account has this verified email (S-7, Joel 2026-11-11: no invitations; they sign
 * up as an ordinary user first). The Staff page shows the message.
 */
const noAccount = () =>
  invalid(
    '/email',
    'staff_email',
    'Ask them to create an account first, then add them.',
  );

/** 409: the change would leave no Admin (the database refuses it too). */
const lastAdmin = () =>
  new ProblemException(
    HttpStatus.CONFLICT,
    'last_admin',
    'Conflict',
    'There must always be at least one admin. Make someone else an admin first.',
  );

/**
 * 502: Clerk, which holds the roles, couldn't make the change, or couldn't be confirmed to agree
 * with the list afterwards. Saving the person again puts the two in step.
 */
const clerkUnavailable = () =>
  new ProblemException(
    HttpStatus.BAD_GATEWAY,
    'clerk_unavailable',
    'Bad gateway',
  );

/** The path's email, lower-case, if it is a staff email (G7). */
function staffEmail(raw: string): string {
  const email = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (email.length > 254 || !STAFF_EMAIL.test(email)) {
    throw invalid(
      '/email',
      'staff_email',
      'Only @heisreal.today email addresses can be staff.',
    );
  }
  return email;
}

function staffRole(body: unknown): StaffRole {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('', 'invalid_body', 'A JSON object.');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => k !== 'role');
  if (unknown) {
    throw invalid(
      `/${unknown}`,
      'unknown_field',
      'Not a field of this command.',
    );
  }
  if (!STAFF_ROLES.includes(b['role'] as StaffRole)) {
    throw invalid('/role', 'invalid_role', 'Moderator or Admin.');
  }
  return b['role'] as StaffRole;
}

const isLastAdmin = (err: unknown) =>
  err instanceof DatabaseQueryError && err.message.includes('staff:last_admin');

/**
 * The staff list and its changes, in the order G8 B sets: Clerk first (the source of truth), then
 * the `staffMember` row. Afterwards (and if the database refuses: the last Admin, a change that
 * overlapped another) Clerk is set again to exactly what the row says, so the two agree.
 */
@Injectable()
export class Staff {
  private readonly logger = new Logger(Staff.name);

  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(STAFF_CLERK) private readonly clerk: StaffClerk,
  ) {}

  async list(): Promise<StaffRow[]> {
    const [rows] = (await runQuery(
      this.db,
      `SELECT email, role, addedBy ?? NULL AS addedBy, addedAt FROM staffMember ORDER BY email;`,
    )) as [StaffRow[]];
    return rows;
  }

  private async current(email: string): Promise<StaffRole | null> {
    const [role] = (await runQuery(
      this.db,
      `SELECT VALUE role FROM ONLY type::record('staffMember', $email);`,
      { email },
    )) as [StaffRole | null];
    return role ?? null;
  }

  private async admins(): Promise<number> {
    const [n] = (await runQuery(
      this.db,
      `count(SELECT VALUE id FROM staffMember WHERE role = 'Admin');`,
    )) as [number];
    return n;
  }

  /**
   * Gives `email` the role `role` (or removes them, `null`) in Clerk, then in the table.
   * `addedBy` names the Admin adding someone new (NONE: the baseline step). Adding or changing a
   * role needs a Clerk account with the verified email (S-7) unless `anyAccount` (the baseline
   * step, which lists them anyway). Throws the API's problems: `validation_failed` (no account),
   * `last_admin`, `clerk_unavailable`.
   */
  async set(
    email: string,
    role: StaffRole | null,
    addedBy: string | null,
    { anyAccount = false }: { anyAccount?: boolean } = {},
  ): Promise<StaffOutcome> {
    const before = await this.current(email);
    if (before === role) {
      // Nothing to change here; Clerk is still made to agree (it is the source of truth).
      const accounts = await this.toClerkAsTable(email);
      // Saving a listed role again still needs an account (S-7), or the page would say they're
      // staff when no account has the role. Removal (null) and the baseline step are exempt.
      if (role !== null && accounts === 0 && !anyAccount) throw noAccount();
      return { change: 'unchanged', accounts };
    }
    // Checked before Clerk is touched, so the usual refusal changes nothing anywhere. The
    // database checks it again, in the write's own transaction.
    if (before === 'Admin' && (await this.admins()) <= 1) throw lastAdmin();

    let accounts: number;
    try {
      ({ count: accounts } = await this.toClerk(email, role));
    } catch (err) {
      // Clerk may have made part of the change: put it back as the table says.
      await this.toClerkAsTable(email);
      throw err;
    }
    // No account had the email, so Clerk changed nothing: refuse before the list does.
    if (role !== null && accounts === 0 && !anyAccount) throw noAccount();
    try {
      await retryOnConflict(() => this.write(email, role, addedBy));
    } catch (err) {
      // Put Clerk back as the table still says, then refuse.
      await this.toClerkAsTable(email);
      if (isLastAdmin(err) || isTransactionConflict(err)) throw lastAdmin();
      throw err;
    }
    // Another change to the same person may have reached Clerk and the table in between, in
    // either order; Clerk is set again to exactly what the table now says, so whichever change
    // finishes last leaves the two agreeing. If that can't be confirmed the request fails (502)
    // even though the table changed: saving the person again makes Clerk agree.
    accounts = await this.toClerkAsTable(email);
    return {
      change: before === null ? 'added' : role === null ? 'removed' : 'changed',
      accounts,
    };
  }

  /**
   * Sets `email`'s Clerk role to exactly their row's (no row: none), reading the row again after
   * each Clerk change and repeating (a few times) while it moved meanwhile. Returns how many
   * Clerk accounts have the email. Throws
   * `clerk_unavailable` when it can't confirm Clerk agrees: a Clerk call failed, or the row was
   * still moving after the last round.
   */
  private async toClerkAsTable(email: string): Promise<number> {
    let role = await this.current(email);
    for (let round = 0; round < 3; round++) {
      let accounts: number;
      try {
        ({ count: accounts } = await this.toClerk(email, role));
      } catch (err) {
        this.logger.error(
          "Clerk couldn't be made to match the staff list: a Clerk call failed; saving the person again fixes it",
        );
        throw err;
      }
      const now = await this.current(email);
      if (now === role) return accounts;
      role = now;
    }
    this.logger.error(
      "Clerk couldn't be made to match the staff list: the role kept changing; saving the person again fixes it",
    );
    throw clerkUnavailable();
  }

  private async toClerk(email: string, role: StaffRole | null) {
    try {
      return await this.clerk.setRole(email, role);
    } catch (err) {
      this.logger.warn(
        `Clerk couldn't set a staff role: ${err instanceof Error ? err.message : 'error'}`,
      );
      throw clerkUnavailable();
    }
  }

  private async write(
    email: string,
    role: StaffRole | null,
    addedBy: string | null,
  ) {
    await runQuery(
      this.db,
      role === null
        ? `DELETE type::record('staffMember', $email);`
        : `IF (SELECT VALUE id FROM ONLY type::record('staffMember', $email)) = NONE {
             CREATE type::record('staffMember', $email)
               CONTENT { email: $email, role: $role, addedBy: $addedBy } RETURN NONE;
           } ELSE {
             UPDATE type::record('staffMember', $email) SET role = $role RETURN NONE;
           };`,
      { email, role, addedBy: addedBy ?? undefined },
    );
  }
}

/**
 * api-admin.yaml, tag Staff (S-1 to S-4, G7, G8 B, G24; Joel 2026-11-11): the Staff page's list
 * and its changes, for Admins only (D1). A change takes effect when the person's session token
 * is next renewed, within about a minute.
 */
@Controller('v1/admin/staff')
export class StaffController {
  constructor(
    private readonly staff: Staff,
    private readonly people: PersonSessions,
  ) {}

  @Get()
  @RequiresRole('Admin')
  async list(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'private, no-store');
    const rows = await this.staff.list();
    return {
      data: rows.map((r) => ({
        email: r.email,
        role: r.role,
        addedBy: r.addedBy ?? null,
        addedAt: new Date(r.addedAt).toISOString(),
        baseline: BASELINE_ADMINS.includes(r.email),
      })),
    };
  }

  /**
   * SetStaffRole: add someone with a role, or change their role. They need a Clerk account with
   * the verified email first (S-7).
   */
  @Put(':email')
  @RequiresRole('Admin')
  async put(
    @Req() req: Request,
    @Param('email') rawEmail: string,
    @Body() body: unknown,
  ) {
    const email = staffEmail(rawEmail);
    const role = staffRole(body);
    const { email: by } = await this.people.authenticate(req);
    await this.staff.set(email, role, by ?? null);
    return { id: email, version: null };
  }

  /** RemoveStaffMember: back to a User, in Clerk and on the list (with or without an account). */
  @Delete(':email')
  @RequiresRole('Admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('email') rawEmail: string) {
    await this.staff.set(staffEmail(rawEmail), null, null);
  }
}

/** How often, and how long, the baseline step tries before giving up until the next start. */
const BASELINE_ATTEMPTS = 20;
const BASELINE_RETRY_MS = 30_000;
/** How long start-up waits for it before serving anyway (the rest carries on meanwhile). */
const BASELINE_STARTUP_WAIT_MS = 15_000;

/**
 * S-4 (Joel, 2026-11-11): "hardcode in the config file a baseline set of admin emails
 * info@heisreal.today and joel@heisreal.today incase we need to reset in the future via pipeline
 * or accidentally lock ourselves out". Each time api-admin starts (so on every deploy), every
 * baseline admin is made Admin on the list, added back if missing, and in Clerk where an account
 * has the email; one with no account yet (S-7: no invitations) is logged, and the next start
 * gives them the role once they have signed up. Nobody else is touched. It runs here, in api-admin, because api-admin already holds the one Clerk client and
 * the table's login; a separate job would need both again. Idempotent: an admin already in
 * place costs one Clerk update. Start-up waits up to 15 s for it, then carries on, retrying
 * (the database may be restarting) every 30 s for ten minutes. It logs what it did.
 */
@Injectable()
export class StaffBaseline implements OnApplicationBootstrap {
  private readonly logger = new Logger(StaffBaseline.name);
  /** Settles when the step has finished, succeeded or not (tests wait for it). */
  done: Promise<void> = Promise.resolve();
  /** The wait between attempts (tests shorten it). */
  retryMs = BASELINE_RETRY_MS;

  constructor(
    private readonly staff: Staff,
    @Inject(STAFF_CLERK) private readonly clerk: StaffClerk,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.clerk.enabled) {
      this.logger.warn(
        'Baseline admins skipped: no Clerk key (CLERK_SECRET_KEY_SECRET)',
      );
      return;
    }
    this.done = this.run();
    await Promise.race([
      this.done,
      new Promise((r) => setTimeout(r, BASELINE_STARTUP_WAIT_MS).unref()),
    ]);
  }

  private async run(): Promise<void> {
    for (let attempt = 1; attempt <= BASELINE_ATTEMPTS; attempt++) {
      try {
        const done: string[] = [];
        for (const email of BASELINE_ADMINS) {
          const { change, accounts } = await this.staff.set(
            email,
            'Admin',
            null,
            { anyAccount: true },
          );
          done.push(
            `${email} ${change === 'unchanged' ? 'already Admin' : change === 'added' ? 'added as Admin' : 'made Admin again'}${accounts === 0 ? ' (no Clerk account with this email yet: the next start gives it the role once they sign up)' : ''}`,
          );
        }
        this.logger.log(
          `Baseline admins in place on the staff list, and in Clerk where they have an account: ${done.join('; ')}`,
        );
        return;
      } catch (err) {
        this.logger.warn(
          `Baseline admins: attempt ${attempt} of ${BASELINE_ATTEMPTS} failed (${err instanceof Error ? err.message : 'error'})`,
        );
        if (attempt < BASELINE_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, this.retryMs).unref());
        }
      }
    }
    this.logger.error(
      'Baseline admins could not be put in place; the next start tries again',
    );
  }
}

@Module({
  controllers: [StaffController],
  providers: [
    {
      provide: STAFF_CLERK,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => createStaffClerk(secrets),
    },
    Staff,
    StaffBaseline,
  ],
})
export class StaffModule {}
