// Synthetic test-only key; never load the user's key or connect to their mailbox in unit tests.
process.env.KOTMAIL_MASTER_KEY = Buffer.alloc(32, 17).toString('base64url');
