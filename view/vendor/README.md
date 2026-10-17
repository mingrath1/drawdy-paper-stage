# Vendored three.js

`three.module.js`, `three.core.js`, and `LICENSE` are unmodified copies from the npm package `three@0.186.1` (`build/`). three.js is MIT licensed, see `LICENSE`.

Drawdy builds only `src/index.ts` and allows no runtime npm dependencies, so `scripts/build-view.mjs` bundles these files into `src/view-html.ts`. Types come from the `@types/three` dev dependency through `three.module.d.ts`.

To update, replace the three files from the new package's `build/` and `LICENSE`, bump `@types/three` to match, and run `npm run build:view`.
