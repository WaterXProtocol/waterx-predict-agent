import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AGENT_COMMANDS, AGENT_COMMAND_SCHEMA_VERSION } from '../src/commands.ts';
import {
  buildCommandDocument,
  serializeCommandDocument,
  COMMAND_DOCUMENT_ID,
} from '../src/document.ts';

const ARTIFACT_PATH = fileURLToPath(
  new URL(`../../../schemas/v${AGENT_COMMAND_SCHEMA_VERSION}/agent-commands.json`, import.meta.url),
);

/** The copy inside this package, which is the one `files` puts in the tarball. */
const SHIPPED_PATH = fileURLToPath(new URL('../agent-commands.json', import.meta.url));

describe('the published command document', () => {
  it('is byte-identical to both committed artifacts', () => {
    // The committed JSON is what a non-TypeScript adapter reads. If it can drift
    // from the source, the contract has two versions and one of them is wrong.
    //
    // The copy inside the package is the same document reaching the only
    // readers who cannot see this repository: a contract described as
    // "published as plain JSON so a surface that cannot import a Node module
    // can read it" is not published while it exists solely in git.
    const expected = serializeCommandDocument(buildCommandDocument());
    expect(readFileSync(ARTIFACT_PATH, 'utf8')).toBe(expected);
    expect(readFileSync(SHIPPED_PATH, 'utf8')).toBe(expected);
  });

  it('serializes deterministically', () => {
    expect(serializeCommandDocument(buildCommandDocument())).toBe(
      serializeCommandDocument(buildCommandDocument()),
    );
  });

  it('survives a JSON round trip without losing a field', () => {
    // Anything `undefined` would vanish on serialization and the adapter would
    // see a weaker schema than the one the tests validated against.
    const document = buildCommandDocument();
    expect(JSON.parse(serializeCommandDocument(document))).toEqual(document);
  });

  it('carries the version and a non-fetchable id', () => {
    const document = buildCommandDocument();
    expect(document.schemaVersion).toBe(AGENT_COMMAND_SCHEMA_VERSION);
    expect(document.$id).toBe(COMMAND_DOCUMENT_ID);
    expect(document.$id.startsWith('urn:')).toBe(true);
  });

  it('publishes every registered command, and no more', () => {
    expect(buildCommandDocument().commands.map((command) => command.name)).toEqual(
      AGENT_COMMANDS.map((command) => command.name),
    );
  });

  it('does not advertise a command the execution core cannot perform', () => {
    // A schema entry is what an adapter turns into a callable tool, so a name
    // that appears here is a promise the CLI must be able to keep. These two
    // have nothing behind them: `market.history` has no server endpoint, and
    // `order.cancel` cannot exist for a market order.
    //
    // `market.search` was on this list and is not any more — the server grew a
    // `?search=` that resolves the text itself. `strategy.create` was on it too,
    // and left the same way: the Runner it needs exists now and serves the whole
    // family over its local socket. That is the ONLY way a name leaves this
    // list — the thing behind it appears. A command must never be added here
    // because the client learned to approximate one.
    const names = new Set(AGENT_COMMANDS.map((command) => command.name));
    for (const unimplemented of ['market.history', 'order.cancel']) {
      expect(names.has(unimplemented), unimplemented).toBe(false);
    }
  });

  it('ends with exactly one newline', () => {
    const contents = serializeCommandDocument(buildCommandDocument());
    expect(contents.endsWith('}\n')).toBe(true);
  });
});
