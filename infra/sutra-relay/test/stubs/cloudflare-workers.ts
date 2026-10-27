// Stand-in for the runtime's "cloudflare:workers" so worker.ts can be imported under Node.
export class DurableObject<Env = unknown> {
  constructor(readonly ctx: unknown, readonly env: Env) {}
}
