const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      // The legal-document PDF cleaner runs in a worker_thread: bundle it as its own file next
      // to main.js (see src/app/legal-documents/pdf/index.ts).
      additionalEntryPoints: [
        {
          entryName: 'legal-pdf-clean-worker',
          entryPath: './src/app/legal-documents/pdf/clean-worker.ts',
        },
      ],
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
