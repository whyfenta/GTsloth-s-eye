/**
 * The Google Apps Script web app that keeps the review team's votes (docs/rx-review-apps-script.gs). Empty: the review page
 * keeps each reviewer's decisions in their own browser and says so. It is a public address, not a secret: reading and writing
 * also need the team's code, which is only in the link the owner shares.
 */
export const REVIEW_ENDPOINT = '';
/** Where the page finds the rule catalog `npm run rx-review-page` writes, under the site's base. */
export const REVIEW_CATALOG = 'assets/rx/review.json';
