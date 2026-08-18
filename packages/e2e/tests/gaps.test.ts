/**
 * The provisioning list is the deliverable when the E2E cannot run, so it gets
 * the same treatment as a shipped surface: every id declared, every supplier
 * named, and the two owner-authenticated entries unable to be quietly demoted
 * into "missing config" that some future automation feels free to fill in.
 */
import { GAP_IDS, PROVISIONING_GAPS, getGap, type GapId } from '../src/gaps.ts';

describe('the provisioning gap list', () => {
  it('declares exactly the ten gaps, in order, and restates none of them', () => {
    // The first seven are WP05A's list, unchanged and not reworded. The last
    // three are what the durable half additionally needs: a Runner on this
    // machine, an owner to attribute the job to, and the operator's own way of
    // restarting their daemon.
    expect([...GAP_IDS]).toEqual([
      'baseUrl',
      'environment',
      'agentWallet',
      'signerCommand',
      'defaultAccount',
      'delegation',
      'ownerRiskProfile',
      'ownerAddress',
      'runner',
      'runnerRestart',
    ]);
  });

  it('never invents a way to stop the operator’s Runner', () => {
    // The restart gap exists precisely because this repository must not guess.
    // A `pkill`, a signal or a pid lookup here would be a way to kill a process
    // nobody asked it to touch.
    const gap = getGap('runnerRestart');
    const text = `${gap.why} ${gap.supplyWith.join(' ')} ${gap.settledBy}`.toLowerCase();
    for (const forbidden of ['pkill', 'killall', 'kill -', 'sigterm', 'sigkill']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(gap.suppliedBy).toBe('OPERATOR');
    expect(gap.needs).toEqual(['runner']);
  });

  it('never infers the owner address, because an address attributes a trade', () => {
    const gap = getGap('ownerAddress');
    expect(gap.suppliedBy).toBe('ACCOUNT_OWNER');
    // Not owner-AUTHENTICATED: knowing the address is not acting as the owner,
    // and conflating the two would make the marker meaningless.
    expect(gap.ownerAuthenticated).toBe(false);
    expect(gap.needs).toEqual([]);
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
