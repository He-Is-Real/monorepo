// People never see error codes or backend state (Joel, 2026-11-09: "dont reveal to the users the
// error code from the backed or its error type/ state, just say try again later"). Whatever went
// wrong on our side (a server error, no answer, a technical refusal), web says only this; the logs
// keep the detail. Two things stay: messages about the person's own input (too long, a limit
// reached), and the database restarting, which web names with when to try again (Joel,
// 2026-11-09: "reveal when compute is restarting with a count down but for any other error it
// should be generic"; components/restarting/restarting-message.tsx).

/** The one message for anything that went wrong on our side. */
export const TRY_AGAIN_LATER = 'Something went wrong. Please try again later.';
