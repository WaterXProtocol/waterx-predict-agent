/**
 * The CycloneDX 1.6 SBOM of one published package.
 *
 * Two properties make this artifact worth committing rather than attaching at
 * publish time:
 *
 * 1. It is **reproducible**. There is no timestamp and no random serial: the
 *    serial number is derived from the document's own content, so regenerating
 *    an unchanged workspace produces a byte-identical file and CI can diff it.
 *    A CycloneDX `metadata.timestamp` is optional precisely for this case, and
 *    a build date is recoverable from the release commit anyway.
 * 2. It states what it does **not** cover. An SBOM that silently omits build
 *    tooling reads as a complete inventory; this one carries the exclusion as a
 *    property, next to the components it did list.
 */
import { createHash } from 'node:crypto';

import { packageKey, type ComponentGraph, type InstalledPackage } from './graph.ts';
import { licenseReviewFor } from './license-review.ts';

export const CYCLONEDX_SPEC_VERSION = '1.6';

/**
 * SPDX identifiers this generator will emit as a licence `id`. Anything else is
 * emitted verbatim as a `name`, because a CycloneDX `id` that is not a real
 * SPDX identifier is an invalid document, and rewriting a package's declared
 * string into one we prefer would be a legal claim this generator cannot make.
 */
const SPDX_IDS: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Unlicense',
]);

export interface SbomOptions {
  /** Name and version of the generator, recorded as the producing tool. */
  readonly tool: { readonly name: string; readonly version: string };
  /** `name@version` → registry integrity string, from the lockfile. */
  readonly integrity: ReadonlyMap<string, string>;
}

interface CycloneLicense {
  readonly license: { readonly id: string } | { readonly name: string };
}

interface CycloneHash {
  readonly alg: string;
  readonly content: string;
}

interface CycloneComponent {
  readonly type: 'library';
  readonly 'bom-ref': string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly licenses?: readonly CycloneLicense[];
  readonly hashes?: readonly CycloneHash[];
  readonly properties?: readonly { readonly name: string; readonly value: string }[];
}

/**
 * Package URL for an npm package. A scoped name splits into a percent-encoded
 * namespace and a name, which is what a consumer's vulnerability scanner keys
 * on; `pkg:npm/@scope/name@1.0.0` unencoded is not a valid purl.
 */
export function npmPurl(name: string, version: string): string {
  const slash = name.indexOf('/');
  if (name.startsWith('@') && slash > 0) {
    const namespace = encodeURIComponent(name.slice(0, slash));
    return `pkg:npm/${namespace}/${name.slice(slash + 1)}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/** An npm integrity string (`sha512-<base64>`) as a CycloneDX hash. */
export function toCycloneHash(integrity: string): CycloneHash | null {
  const match = /^(sha1|sha256|sha384|sha512)-(.+)$/u.exec(integrity.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  let content: string;
  try {
    content = Buffer.from(match[2], 'base64').toString('hex');
  } catch {
    return null;
  }
  if (content === '') return null;
  return { alg: match[1].replace(/^sha/u, 'SHA-'), content };
}

const asLicense = (declared: string): CycloneLicense =>
  SPDX_IDS.has(declared) ? { license: { id: declared } } : { license: { name: declared } };

/**
 * The licence to publish for a component: the declared string, or — when the
 * package declares none — the human finding recorded in `license-review.ts`.
 * The component's properties say which of the two it was, so a reader never has
 * to trust that a licence here came from the package itself.
 */
const licensesOf = (pkg: InstalledPackage): readonly CycloneLicense[] | undefined => {
  if (pkg.license !== null) return [asLicense(pkg.license)];
  const review = licenseReviewFor(packageKey(pkg));
  return review === undefined ? undefined : [asLicense(review.license)];
};

const componentOf = (pkg: InstalledPackage, options: SbomOptions): CycloneComponent => {
  const purl = npmPurl(pkg.name, pkg.version);
  const integrity = options.integrity.get(packageKey(pkg));
  const hash = integrity === undefined ? null : toCycloneHash(integrity);
  const licenses = licensesOf(pkg);

  const properties: { name: string; value: string }[] = [];
  // Carried per component rather than checked only at generate time: the floor
  // the published packages promise is `>=20`, and a component that needs more
  // breaks it on a consumer's machine rather than here.
  if (pkg.engines !== null) properties.push({ name: 'waterx:engines.node', value: pkg.engines });
  if (pkg.license === null) {
    const review = licenseReviewFor(packageKey(pkg));
    properties.push({
      name: 'waterx:license-source',
      value:
        review === undefined
          ? 'UNDECLARED. The package declares no licence and none has been reviewed.'
          : `HUMAN_REVIEW. The package declares no licence. ${review.evidence}`,
    });
  }

  return {
    type: 'library',
    'bom-ref': purl,
    name: pkg.name,
    version: pkg.version,
    purl,
    ...(licenses === undefined ? {} : { licenses }),
    ...(hash === null ? {} : { hashes: [hash] }),
    ...(properties.length === 0 ? {} : { properties }),
  };
};

/**
 * A UUID derived from the document's content.
 *
 * CycloneDX requires a `urn:uuid:` serial. A random one would change on every
 * run and defeat the byte-for-byte comparison this repository uses to prove a
 * committed artifact is still the generator's output, so this is a version-8
 * (custom) UUID over the SHA-256 of the serial-free document: identical inputs
 * give an identical serial, and any change to any component gives a new one.
 */
export function contentSerialNumber(document: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    'urn:uuid:',
    digest.slice(0, 8),
    '-',
    digest.slice(8, 12),
    '-8',
    digest.slice(13, 16),
    '-',
    variant,
    digest.slice(17, 20),
    '-',
    digest.slice(20, 32),
  ].join('');
}

/** Build the SBOM document for one published package. */
export function buildSbom(graph: ComponentGraph, options: SbomOptions): Record<string, unknown> {
  const rootComponent = componentOf(graph.root, options);
  const components = graph.components.map((pkg) => componentOf(pkg, options));

  const byKey = new Map<string, InstalledPackage>();
  for (const pkg of [graph.root, ...graph.components]) byKey.set(packageKey(pkg), pkg);

  const dependencies = [graph.root, ...graph.components].map((pkg) => ({
    ref: npmPurl(pkg.name, pkg.version),
    dependsOn: pkg.dependsOn
      .map((key) => byKey.get(key))
      .filter((dependency): dependency is InstalledPackage => dependency !== undefined)
      .map((dependency) => npmPurl(dependency.name, dependency.version)),
  }));

  const properties = [
    {
      name: 'waterx:scope',
      // Named rather than implied. A reader who assumes this covers the build
      // toolchain would read an absent component as an absent risk.
      value: 'RUNTIME_DEPENDENCIES_ONLY. devDependencies and build tooling are excluded.',
    },
    {
      name: 'waterx:resolution',
      value: 'INSTALLED_TREE. Versions come from node_modules on disk, not from a manifest range.',
    },
    {
      name: 'waterx:timestamp',
      value: 'OMITTED_FOR_REPRODUCIBILITY. The build date is the release commit date.',
    },
  ];

  for (const dependency of graph.unresolved) {
    properties.push({
      name: dependency.optional ? 'waterx:optional-dependency-absent' : 'waterx:dependency-unresolved',
      value: `${dependency.from} → ${dependency.name}`,
    });
  }

  const document = {
    bomFormat: 'CycloneDX',
    specVersion: CYCLONEDX_SPEC_VERSION,
    version: 1,
    metadata: {
      component: rootComponent,
      tools: {
        components: [
          {
            type: 'application',
            name: options.tool.name,
            version: options.tool.version,
          },
        ],
      },
      properties,
    },
    components,
    dependencies,
  };

  return { ...document, serialNumber: contentSerialNumber(document) };
}

/** Serialize with a trailing newline, the way every committed artifact here is. */
export const serializeSbom = (document: Record<string, unknown>): string =>
  `${JSON.stringify(document, null, 2)}\n`;
