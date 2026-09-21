/**
 * The encoder, against an independent one.
 *
 * Both the encoder and these vectors are ported from the perp agent; see
 * `src/qr.ts`.
 *
 * `test/fixtures/qr.json` was generated once from the npm `qrcode` package --
 * matrices for three payloads, and the ISO/IEC 18004 tables they rest on. The
 * package itself has no dependency on it. Nothing here is a self-consistency
 * check: the comparison is module for module against somebody else's output,
 * which is the only kind of check worth having for arithmetic like this.
 */
import { describe, expect, it } from "vitest";

import { encodeQr, qrLines, renderQr } from "../src/qr.ts";
import fixtures from "./fixtures/qr.json" with { type: "json" };

interface Vector {
  name: string;
  text: string;
  version: number;
  size: number;
  rows: string[];
}

const vectors = fixtures.vectors as Vector[];
const LINK = `https://waterx.app/en/agent/authorize/perp?agent=0x${"a".repeat(64)}`;
const ESC = String.fromCharCode(27);
const asRows = (modules: boolean[][]): string[] =>
  modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

describe("encodeQr", () => {
  it("produces the same symbol as the reference implementation, module for module", () => {
    for (const vector of vectors) {
      const code = encodeQr(vector.text);

      expect(code, vector.name).toBeDefined();
      expect(code?.version, vector.name).toBe(vector.version);
      expect(code?.size, vector.name).toBe(vector.size);
      expect(asRows(code?.modules ?? []), vector.name).toEqual(vector.rows);
    }
  });

  it("picks the smallest version that holds the payload", () => {
    // An authorize link is about 115 bytes, which is version 7 at level M. If
    // this starts choosing bigger symbols the code stops fitting an 80-column
    // terminal, which is the whole reason it is drawn rather than linked.
    expect(encodeQr("HELLO")?.version).toBe(1);
    expect(encodeQr(LINK)?.version).toBe(7);
  });

  it("gives up rather than drawing something unreadable", () => {
    // Past version 10 the caller still has the link it was going to draw, and a
    // symbol too dense to scan off a screen would be worse than nothing.
    expect(encodeQr("x".repeat(400))).toBeUndefined();
    expect(qrLines("x".repeat(400))).toBeUndefined();
  });

  it("keeps the size the version implies", () => {
    const code = encodeQr(`https://console.internal/grant?flow=perp&agent=0x${"AbCdEf".repeat(10)}`);

    expect(code).toBeDefined();
    expect(code?.size).toBe((code?.version ?? 0) * 4 + 17);
  });
});

describe("renderQr", () => {
  const code = encodeQr(LINK);
  const plain = (): string[] =>
    renderQr(code ?? { version: 1, size: 21, mask: 0, modules: [] }, { color: false });

  it("keeps the quiet zone a reader is entitled to", () => {
    // Four light modules on every side. Without them a reader has nothing to
    // find the symbol's edge against, and the code silently stops scanning.
    const lines = plain();
    const span = (code?.size ?? 0) + 8;

    expect(lines).toHaveLength(Math.ceil(span / 2));
    expect(lines[0]?.trim()).toBe("");
    expect(lines[1]?.trim()).toBe("");
    for (const line of lines) {
      expect(line.slice(0, 4)).toBe("    ");
      expect(line.slice(-4)).toBe("    ");
    }
  });

  it("fits a terminal, which is why it is half blocks", () => {
    // A cell is about twice as tall as it is wide: one cell per module across,
    // two down. Version 7 plus the quiet zone is 53 columns -- an 80-column
    // terminal holds it, and whole blocks would need 106.
    const lines = plain();

    expect(lines[0]?.length).toBe(53);
    expect(lines.length).toBeLessThan(30);
  });

  it("carries its own colours, so a dark theme does not invert it", () => {
    // Ink on the terminal's own background is inverted on a dark theme, and a
    // reader is not obliged to cope with that.
    const lines = renderQr(code ?? { version: 1, size: 21, mask: 0, modules: [] });

    expect(lines[0]).toContain(ESC + "[");
    expect(lines[0]?.endsWith(ESC + "[0m")).toBe(true);
  });
});

/**
 * What an agent can learn from what it actually reads (ADR-0024).
 *
 * A real perp session worked out for itself that opening a browser on the
 * machine running the agent was the wrong thing — and never mentioned `--qr`,
 * because nothing it read named it. The option lived in `--help`, which an
 * agent following the contract never opens. So the surfaces it DOES read are
 * measured here rather than assumed.
 */
describe('the surface an agent reads', () => {
  it('names the code and whose switch the browser is, in the owner’s state', async () => {
    const { invoke } = await import('./harness.ts');
    const { AUTH_OK, CONFIGURED_ENV } = await import('./harness.ts');
    const result = await invoke(['next', '--json'], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_CONSOLE_URL: 'https://console.test.invalid' },
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        // The listing answers, and nothing in it is granted to this agent.
        'GET /agent-api/v1/predict/accounts': { status: 200, body: { accounts: [] } },
      },
    });
    const data = result.envelope.data as {
      state: string;
      handOver?: { message?: string };
      agentSteps?: { why: string }[];
    };
    expect(data.state).toBe('AWAITING_OWNER');
    // The case this arrangement is built for: the owner is somewhere else.
    expect(data.handOver?.message).toContain('onboard --qr');
    // And whose call the browser is, where the agent is told to run the command
    // that opens one.
    expect(data.agentSteps?.[0]?.why).toContain('--no-open');
  });
});
