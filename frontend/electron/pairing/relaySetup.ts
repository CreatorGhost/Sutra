// One-click "Reach from anywhere" (after ViewCode's Quick connect): sign in to the user's own
// Cloudflare account with wrangler's device flow (Settings shows the link + code and opens it), ask
// which account if the sign-in has several, deploy Sutra's relay Worker, give the account a
// workers.dev address if it has none, store a fresh host secret on the Worker (stdin only) and in
// pairing.json, then check the relay accepts this Mac before calling it done. Also removes it.
//
// One operation at a time; closing Settings doesn't stop it. No Electron imports: index.ts wires the
// real wrangler, HTTP and storage in, tests drive it with fakes. wrangler output is redacted of every
// secret before it's kept, and never logged.
import {
  DEFAULT_WORKER_NAME, VERIFY_DELAYS_S, detectMissingWorkersDevSubdomain, detectWorkerAlreadyDeleted, deviceLoginOpenUrl,
  generateHostSecret, isValidWorkerName, parseDeployAccountId, parseDeviceLoginPrompt, parseWhoamiAccounts, parseWorkerUrl,
  parseWranglerAuthToken, redactSecrets, wranglerNeedsLogin,
  type CloudflareAccount, type DeployedRelay, type ProbeOutcome, type ProbeProblem, type RelaySetupState, type SetupStep,
} from "../../src/shared/pairing/relaySetup";
import { SetupError, type RunResult, type WranglerSession } from "./wrangler";

export interface RelaySetupDeps {
  prepare(onProgress: (message: string) => void, workerName: string): Promise<WranglerSession>;
  /** GET <url>/host/<hostId> with the secret; never throws. */
  probe(url: string, secret: string): Promise<ProbeOutcome>;
  /** A Cloudflare API call with wrangler's own sign-in token (only to create a workers.dev subdomain). */
  cfApi(token: string, method: "GET" | "PUT", path: string, body?: unknown): Promise<{ status: number; json: any }>;
  /** pairing.json's relay settings (through PairingHost.setRelay, so the connector follows). */
  relay(): { url: string; hostSecret: string | null; enabled: boolean };
  saveRelay(p: { url?: string; hostSecret?: string; enabled?: boolean }): void;
  readDeployed(): DeployedRelay | null;
  writeDeployed(d: DeployedRelay | null): void;
  openExternal(url: string): void;
  onState(s: RelaySetupState): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
}

const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const DETAILS_MAX = 16_000;
const REJECTIONS_BEFORE_REPORTING = 3;
const SUBDOMAIN_NONE = 10007, NAME_TAKEN = 10031, NAME_AVAILABLE = 10032;

const STEP: Record<SetupStep, string> = {
  tools: "Getting ready…",
  signin: "Sign in to Cloudflare to continue…",
  deploy: "Setting up your relay…",
  secret: "Securing it…",
  verify: "Checking it works…",
  remove: "Removing your relay…",
};

const WAITING: Record<ProbeProblem, string> = {
  network: "Waiting for your network to allow the new address. This can take a few minutes — you can close this, Sutra keeps trying.",
  transient: "Waiting for the new address to come online — you can close this, Sutra keeps trying.",
  rejected: "The relay hasn't accepted this computer's secret yet. Checking again…",
};
const UNREACHABLE: Record<ProbeProblem, string> = {
  network: "Your relay is set up, but this network still blocks its new address. Sutra connects as soon as it's allowed; same Wi-Fi works meanwhile.",
  transient: "Your relay is set up, but its address isn't answering yet. Sutra keeps trying in the background.",
  rejected: "The relay doesn't accept this computer's secret. Choose Redeploy with a new secret to fix it.",
};

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(new SetupError("Cancelled.")); }, { once: true });
});

interface DeployOptions { rotateSecret: boolean; accountId?: string }

export class RelaySetup {
  private s: RelaySetupState = { status: "idle" };
  private abort: AbortController | null = null;
  private secrets: (string | null)[] = [];
  private details = "";
  private pending: DeployOptions | null = null;
  private connectedEarly = false;

  constructor(private readonly d: RelaySetupDeps) {}

  get state(): RelaySetupState { return this.s; }
  get running(): boolean { return this.s.status === "running"; }

  /** Set up (or redeploy) the relay. `rotateSecret` only when asked: an unchanged secret keeps phones working. */
  start(o: { rotateSecret?: boolean } = {}): void { this.launch(() => this.deploy({ rotateSecret: o.rotateSecret === true })); }
  /** Answer "which account?". */
  chooseAccount(accountId: string): void { const p = this.pending ?? { rotateSecret: false }; this.launch(() => this.deploy({ ...p, accountId })); }
  /** After the person picked a workers.dev name in the dashboard themselves. */
  continueSetup(): void { const p = this.pending ?? { rotateSecret: false }; this.launch(() => this.deploy(p)); }
  /** Delete the Worker from Cloudflare (unless `localOnly`) and forget it here. */
  remove(o: { localOnly?: boolean } = {}): void { this.launch(() => this.removeRelay(o.localOnly === true)); }

  /** Stop what's running (and its wrangler), or dismiss a finished state. */
  cancel(): void {
    if (this.abort) { this.abort.abort(); return; }
    this.publish({ status: "idle" });
  }

  /** The connector reached the relay: proof it works, even if this Mac's own probes were refused. */
  relayConnected(): void {
    this.connectedEarly = true;
    if (this.s.status === "unreachable") this.publish({ status: "done", message: "Your relay is set up. Phones can reach this computer from anywhere." });
  }

  // ---- plumbing ----

  private publish(s: RelaySetupState): void { this.s = s; this.d.onState(s); }
  private step(step: SetupStep, extra: Partial<Extract<RelaySetupState, { status: "running" }>> = {}): void {
    this.publish({ status: "running", step, message: STEP[step], ...extra });
  }
  private keep(r: RunResult | string): void {
    const t = redactSecrets(typeof r === "string" ? r : r.output, this.secrets).trim();
    if (t) this.details = `${this.details}${this.details ? "\n\n" : ""}${t}`.slice(-DETAILS_MAX);
  }
  private withDetails<T extends RelaySetupState>(s: T): T { return this.details ? { ...s, details: this.details } : s; }

  private launch(op: () => Promise<void>): void {
    if (this.running) throw new Error("Relay setup is already running.");
    const ac = new AbortController();
    this.abort = ac;
    this.details = "";
    this.secrets = [];
    this.connectedEarly = false;
    this.step("tools");
    void op()
      .catch((e: unknown) => {
        if (ac.signal.aborted) { this.publish({ status: "idle" }); return; }
        const err = e instanceof SetupError ? e : new SetupError("Relay setup stopped unexpectedly. Try again.", String((e as any)?.message ?? e));
        if (err.details) this.keep(err.details);
        this.publish(this.withDetails({ status: "failed", message: err.message, ...(err.installNode ? { installNode: true } : {}) }));
      })
      .finally(() => { if (this.abort === ac) this.abort = null; });
  }

  private get signal(): AbortSignal { return this.abort!.signal; }
  private sleep(ms: number): Promise<void> { return (this.d.sleep ?? defaultSleep)(ms, this.signal); }

  private async session(name: string): Promise<WranglerSession> {
    return this.d.prepare((message) => this.step("tools", { message }), name);
  }

  // ---- steps ----

  private async signIn(w: WranglerSession): Promise<void> {
    // The first wrangler run also downloads wrangler, so this is still "getting ready".
    const who = await w.run(["whoami"], { signal: this.signal });
    if (!wranglerNeedsLogin(redactSecrets(who.output, this.secrets), who.code)) return;
    this.step("signin", { signIn: { url: null, code: null, openUrl: null } });
    let printed = "", opened = false;
    // `--browser=false`: Settings shows the link and code, and opens the browser itself (once).
    const login = await w.run(["login", "--device", "--browser=false"], {
      signal: this.signal,
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      onOutput: (t) => {
        printed += t;
        const prompt = parseDeviceLoginPrompt(redactSecrets(printed, this.secrets));
        const openUrl = deviceLoginOpenUrl(prompt);
        this.step("signin", { signIn: { ...prompt, openUrl } });
        if (openUrl && prompt.code && !opened) { opened = true; this.d.openExternal(openUrl); }
      },
    });
    this.keep(login);
    if (login.code !== 0) throw new SetupError("The Cloudflare sign-in didn't finish. Try again.");
  }

  /** `preferred` while the sign-in still reaches it, else the only account; with several, the person chooses. */
  private async account(w: WranglerSession, preferred: string | null): Promise<{ id: string | null } | { choices: CloudflareAccount[] }> {
    const who = await w.run(["whoami", "--json"], { signal: this.signal });
    const accounts = who.code === 0 ? parseWhoamiAccounts(who.output) : null;
    if (!accounts?.length) return { id: preferred }; // unreadable: let wrangler decide (or explain)
    if (preferred && accounts.some((a) => a.id === preferred)) return { id: preferred };
    if (accounts.length === 1) return { id: accounts[0]!.id };
    return { choices: accounts };
  }

  /** Give an account without a workers.dev subdomain a `sutra-xxxxxx` one, the calls wrangler itself makes. */
  private async createSubdomain(w: WranglerSession, deployOutput: string, accountId: string | null): Promise<boolean> {
    this.step("deploy", { message: "Creating your free workers.dev address…" });
    const acct = accountId ?? parseDeployAccountId(deployOutput);
    if (!acct) { this.keep("Couldn't tell which Cloudflare account needs the workers.dev address."); return false; }
    // This output IS the sign-in token: never kept.
    const auth = await w.run(["auth", "token", "--json"], { signal: this.signal, accountId: acct });
    const token = auth.code === 0 ? parseWranglerAuthToken(auth.output) : null;
    if (!token) { this.keep("Couldn't read the Cloudflare sign-in to create the workers.dev address."); return false; }
    this.secrets.push(token);
    const base = `/accounts/${encodeURIComponent(acct)}/workers`;
    const code = (j: any): number | undefined => j?.errors?.[0]?.code;
    try {
      const cur = await this.d.cfApi(token, "GET", `${base}/subdomain`);
      if (cur.json?.success && cur.json?.result?.subdomain) return true;
      if (code(cur.json) !== SUBDOMAIN_NONE) { this.keep(`Cloudflare answered ${cur.status} about the workers.dev address.`); return false; }
      const rnd = this.d.random ?? Math.random;
      for (let i = 0; i < 4; i++) {
        let name = "sutra-";
        for (let k = 0; k < 6; k++) name += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rnd() * 36)];
        const check = await this.d.cfApi(token, "GET", `${base}/subdomains/${name}`);
        if (code(check.json) === NAME_TAKEN) continue;
        if (!check.json?.success && code(check.json) !== NAME_AVAILABLE) { this.keep(`Cloudflare answered ${check.status} checking ${name}.workers.dev.`); return false; }
        const claim = await this.d.cfApi(token, "PUT", `${base}/subdomain`, { subdomain: name });
        if (claim.json?.success) { this.keep(`Created ${claim.json?.result?.subdomain ?? name}.workers.dev for this account.`); return true; }
        if (code(claim.json) !== NAME_TAKEN) { this.keep(`Cloudflare answered ${claim.status} creating ${name}.workers.dev.`); return false; }
      }
      this.keep("Every workers.dev name tried was taken.");
    } catch (e: any) {
      this.keep(`Couldn't reach Cloudflare to create the workers.dev address: ${redactSecrets(String(e?.message ?? e), this.secrets)}`);
    }
    return false;
  }

  private async verify(url: string, secret: string): Promise<void> {
    this.step("verify");
    let rejected = 0;
    for (let attempt = 0; ; attempt++) {
      if (this.connectedEarly) break;
      const r = await this.d.probe(url, secret);
      if (r.ok) break;
      rejected = r.problem === "rejected" ? rejected + 1 : 0;
      const delay = VERIFY_DELAYS_S[attempt];
      if (rejected >= REJECTIONS_BEFORE_REPORTING || delay === undefined) {
        // Saved settings stay: the connector keeps retrying on its own.
        this.keep(r.detail);
        this.publish(this.withDetails({ status: "unreachable", message: UNREACHABLE[r.problem] }));
        return;
      }
      this.step("verify", { message: WAITING[r.problem] });
      await this.sleep(delay * 1000);
    }
    this.publish({ status: "done", message: "Your relay is set up. Phones can reach this computer from anywhere." });
  }

  private async deploy(o: DeployOptions): Promise<void> {
    const remembered = this.d.readDeployed();
    const name = remembered && isValidWorkerName(remembered.name) ? remembered.name : DEFAULT_WORKER_NAME;
    const stored = this.d.relay().hostSecret;
    this.secrets = [stored];
    const w = await this.session(name);
    try {
      await this.signIn(w);
      const acct = await this.account(w, o.accountId ?? remembered?.accountId ?? null);
      if ("choices" in acct) {
        this.pending = o;
        this.publish(this.withDetails({ status: "needs-account", accounts: acct.choices, message: "Your Cloudflare sign-in has several accounts. Choose one for the relay." }));
        return;
      }
      const accountId = acct.id;
      this.step("deploy");
      const deploy = async () => { const r = await w.run(["deploy", "--config", w.configPath, "--name", name], { signal: this.signal, accountId }); this.keep(r); return r; };
      let out = await deploy();
      let url = parseWorkerUrl(out.output, name);
      // Checked before the exit code: without a subdomain wrangler may exit non-zero.
      if (!url && detectMissingWorkersDevSubdomain(out.output) && (await this.createSubdomain(w, out.output, accountId))) {
        this.step("deploy");
        out = await deploy();
        url = parseWorkerUrl(out.output, name);
      }
      if (!url && detectMissingWorkersDevSubdomain(out.output)) {
        this.pending = { ...o, ...(accountId ? { accountId } : {}) };
        const acctId = accountId ?? parseDeployAccountId(out.output);
        this.publish(this.withDetails({
          status: "needs-subdomain",
          message: "Your Cloudflare account needs a free workers.dev address first. Open Cloudflare, choose one under Workers & Pages, then come back and continue.",
          dashboard: acctId ? `https://dash.cloudflare.com/${acctId}/workers/onboarding` : "https://dash.cloudflare.com/",
        }));
        return;
      }
      if (out.code !== 0) throw new SetupError("Cloudflare didn't accept the relay. Try again.");
      if (!url) throw new SetupError("The relay was deployed, but Cloudflare didn't report its address. Try again.");

      this.step("secret");
      const secret = (o.rotateSecret ? null : stored) ?? generateHostSecret();
      this.secrets.push(secret);
      const put = await w.run(["secret", "put", "HOST_SECRET", "--name", name, "--config", w.configPath], { signal: this.signal, accountId, input: `${secret}\n` });
      this.keep(put);
      if (put.code !== 0) throw new SetupError("Couldn't store the relay's secret on Cloudflare. Nothing changed on this computer. Try again.");
      // Past this point a Cancel must not leave the address and secret out of step: no abort checks.
      this.d.writeDeployed({ name, url, accountId });
      this.d.saveRelay({ url, hostSecret: secret, enabled: true });
      this.pending = null;
      await this.verify(url, secret);
    } finally {
      await w.dispose().catch(() => {});
    }
  }

  private async removeRelay(localOnly: boolean): Promise<void> {
    const remembered = this.d.readDeployed();
    if (remembered && !localOnly) {
      let deleted = false;
      try {
        const w = await this.session(remembered.name);
        try {
          this.secrets = [this.d.relay().hostSecret];
          await this.signIn(w);
          this.step("remove");
          const r = await w.run(["delete", "--name", remembered.name, "--config", w.configPath, "--force"], { signal: this.signal, accountId: remembered.accountId });
          this.keep(r);
          deleted = r.code === 0 || detectWorkerAlreadyDeleted(r.output);
        } finally { await w.dispose().catch(() => {}); }
      } catch (e) {
        if (this.signal.aborted) throw e;
        this.keep(e instanceof Error ? e.message : String(e));
      }
      if (!deleted) {
        this.publish(this.withDetails({ status: "failed", message: "Couldn't delete the relay from Cloudflare. Nothing changed on this computer. Try again, or remove it from this computer only." }));
        return;
      }
    }
    this.step("remove");
    this.d.saveRelay({ url: "", hostSecret: "", enabled: false });
    this.d.writeDeployed(null);
    this.publish({
      status: "idle",
      message: localOnly ? "Removed from this computer. The relay is still on your Cloudflare account." : remembered ? "Your relay is removed." : "Removed from this computer. If you set up the relay yourself, delete it in the Cloudflare dashboard.",
    });
  }
}
