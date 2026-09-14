import globals from "globals";

export default [
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  { ignores: ["node_modules/**", "runtime-lock/**", "public-release/**"] },
  { files: ["src/**/*.{js,cjs}", "bootstrap/**/*.cjs", "bin/**/*.js"],
    languageOptions: { globals: globals.node }, rules: { "no-undef": "error" } },
  // These modules contain functions serialized into a browser renderer.
  { files: ["src/codex-desktop.js", "src/onboarding-review-bridge.js"], languageOptions: { globals: globals.browser } },
];
