import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';
import webUi from './eslint/index.mjs';

export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
  {
    ignores: ['**/out-tsc'],
  },
  // Its own colours are the theme's too (eslint/index.mjs).
  ...webUi.configs.library,
];
