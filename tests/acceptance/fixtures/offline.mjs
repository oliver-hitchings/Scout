// Apply before importing the real server/CLI. Acceptance may reach source
// collection after reconnecting, but must never contact a real external service.
globalThis.fetch = async () => {
  const error = new Error('Synthetic acceptance refuses external source HTTP');
  error.code = 'ENETUNREACH';
  throw error;
};
