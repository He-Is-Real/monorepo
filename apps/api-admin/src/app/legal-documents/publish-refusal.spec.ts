import { DatabaseQueryError } from '@heisreal/database';
import { publishRefusal } from './legal-documents.controller';

/**
 * Two admins publishing the same document at once: whether the loser's transaction sees the
 * winner's version (the transaction's own `document_changed`) or conflicts with it at commit
 * depends on timing, so the integration test can't pick the branch. Both must answer 409
 * document_changed, never a 500.
 */
describe('publishRefusal', () => {
  const codeOf = (err: unknown) =>
    (publishRefusal(err)?.getResponse() as { code?: string } | undefined)?.code;

  it('answers a commit-time transaction conflict as 409 document_changed', () => {
    const err = new DatabaseQueryError(
      'Transaction conflict: Resource busy. This transaction can be retried',
      0,
    );
    expect(publishRefusal(err)?.getStatus()).toBe(409);
    expect(codeOf(err)).toBe('document_changed');
  });

  it('keeps the transaction’s own refusals, and lets anything else through', () => {
    expect(codeOf(new Error('An error occurred: document_changed: …'))).toBe(
      'document_changed',
    );
    // Both took the next number: the unique index refuses the second.
    expect(
      codeOf(
        new Error(
          'Database index `dpa_number` already contains 3, with record `dpaVersion:x`',
        ),
      ),
    ).toBe('document_changed');
    expect(publishRefusal(new Error('the database is down'))).toBeNull();
  });
});
