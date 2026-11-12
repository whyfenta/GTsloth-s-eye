/**
 * The Google Apps Script web app that keeps the review team's votes (docs/rx-review-apps-script.gs). Empty: the review page
 * keeps each reviewer's decisions in their own browser and says so. It is a public address, not a secret: reading and writing
 * also need the team's code, which is only in the link the owner shares.
 */
export const REVIEW_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzZHyeMcs69ITwzWmZ9KNRS--WAWhcAYSuFtoQW3d2wMx27j1BNRUdhXNs5G2MckG-i/exec';
/** Where the page finds the rule catalog `npm run rx-review-page` writes, under the site's base. */
export const REVIEW_CATALOG = 'assets/rx/review.json';
/** The open proposals published with the site (`npm run rx-proposals -- --publish`); the team's sheet adds newer ones. */
export const REVIEW_PROPOSALS = 'assets/rx/proposals.json';
