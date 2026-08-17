/**
 * The provisioning list is the deliverable when the E2E cannot run, so it gets
 * the same treatment as a shipped surface: every id declared, every supplier
 * named, and the two owner-authenticated entries unable to be quietly demoted
 * into "missing config" that some future automation feels free to fill in.
 */
import { GAP_IDS, PROVISIONING_GAPS, getGap, type GapId } from '../src/gaps.ts';

describe('the provisioning gap list', () => {
  it('declares exactly the seven gaps the work package names, in order', () => {
    expect([...GAP_IDS]).toEqual([
      'baseUrl',
      'environment',
      'agentWallet',
      'signerCommand',
      'defaultAccount',
      'delegation',
      'ownerRiskProfile',
    ]);
  });

  it('describes every declared gap exactly once', () => {
    expect(PROVISIONING_GAPS.map((gap) => gap.id)).toEqual([...GAP_IDS]);
    for (const id of GAP_IDS) expect(getGap(id).id).toBe(id);
  });

  it('names a supplier, a reason, a way to supply it and a way to check it', () => {
    for (const gap of PROVISIONING_GAPS) {
      expect(['OPERATOR', 'ACCOUNT_OWNER'], gap.id).toContain(gap.suppliedBy);
      // A gap whose text is "TBD" is not a gap list, it is a note to self.
      expect(gap.why.length, gap.id).toBeGreaterThan(40);
      expect(gap.supplyWith.length, gap.id).toBeGreaterThan(0);
      expect(gap.settledBy.length, gap.id).toBeGreaterThan(10);
    }
  });

  it('marks the two owner-authenticated gaps, and only those', () => {
    const ownerAuthenticated = PROVISIONING_GAPS.filter((gap) => gap.ownerAuthenticated).map(
      (gap) => gap.id,
    );
    expect(ownerAuthenticated).toEqual(['delegation', 'ownerRiskProfile']);
    for (const id of ownerAuthenticated) {
      const gap = getGap(id);
      expect(gap.suppliedBy, id).toBe('ACCOUNT_OWNER');
      // The instruction has to say plainly that this pipeline does not do it.
      // ADR-0003's whole control is that an agent runtime cannot provision its
      // own mandate, and a gap list that read like a TODO for automation would
      // invite exactly the self-widening the ADR exists to prevent.
      expect(gap.supplyWith.join(' '), id).toContain('OWNER ACTION');
      expect(gap.supplyWith.join(' '), id).toContain('must not attempt');
    }
  });

  it('never lets a gap depend on itself or on something undeclared', () => {
    for (const gap of PROVISIONING_GAPS) {
      for (const need of gap.needs) {
        expect(GAP_IDS as readonly GapId[], `${gap.id} needs ${need}`).toContain(need);
        expect(need, gap.id).not.toBe(gap.id);
      }
    }
  });

  it('makes the owner-authenticated gaps checkable only once the runtime can reach a server', () => {
    // Otherwise the harness would report "no delegation" on a machine that never
    // opened a socket — a claim about a conversation nobody had.
    for (const id of ['delegation', 'ownerRiskProfile'] as const) {
      expect([...getGap(id).needs].sort(), id).toEqual([
        'agentWallet',
        'baseUrl',
        'defaultAccount',
        'signerCommand',
      ]);
    }
  });

  it('never suggests supplying a secret through this runtime', () => {
    // The wallet gap supplies an ADDRESS. The signer gap supplies a COMMAND. A
    // private key belongs in neither, and the instructions must not read as
    // though it might.
    for (const gap of PROVISIONING_GAPS) {
      const text = `${gap.why} ${gap.supplyWith.join(' ')}`.toLowerCase();
      expect(text, gap.id).not.toMatch(/paste your (private )?key|set .*private_key=/u);
    }
    expect(getGap('agentWallet').why).toContain('never appears here');
    expect(getGap('signerCommand').why).toContain('never receives one');
  });
});
