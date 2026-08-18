/**
 * Human licence findings for shipped dependencies that declare none.
 *
 * npm's `license` field is the machine-readable answer, and a package that
 * omits it is not a package without a licence — it is a package whose licence
 * a person has to go and read. Guessing in the generator would put an
 * unverified legal claim in an artifact consumers rely on, so the generator
 * reports `null` and this file records what a person found instead.
 *
 * Each entry is pinned to an exact version. A review of 2.1.2 says nothing
 * about 2.2.0, and the preflight fails a review that no longer matches a
 * shipped component rather than letting it drift into a blanket exemption.
 */
export interface LicenseReview {
  /** Exact `name@version` this finding applies to. */
  readonly component: string;
  /** The SPDX identifier the reviewer concluded. */
  readonly license: string;
  /** Where they read it. Specific enough for the next person to repeat. */
  readonly evidence: string;
}

export const LICENSE_REVIEWS: readonly LicenseReview[] = [
  {
    component: 'xmlhttprequest-ssl@2.1.2',
    license: 'MIT',
    evidence:
      'No `license` field. The manifest uses npm\'s deprecated `licenses: [{type: "MIT"}]` array ' +
      'form, and the package ships a verbatim MIT text at LICENSE (Copyright (c) 2010 passive.ly ' +
      'LLC). Reached only as a transitive dependency of socket.io-client via engine.io-client. ' +
      'Reviewed 2026-08-18 during the WP14 release audit.',
  },
];

const BY_COMPONENT: ReadonlyMap<string, LicenseReview> = new Map(
  LICENSE_REVIEWS.map((review) => [review.component, review]),
);

export const licenseReviewFor = (componentKey: string): LicenseReview | undefined =>
  BY_COMPONENT.get(componentKey);
