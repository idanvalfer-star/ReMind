import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'public', 'node_modules', '.wrangler', 'dev-dist'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    // `recommended-latest` is the flat-config entry point in react-hooks v5.
    extends: [reactHooks.configs['recommended-latest']],
  },
  {
    rules: {
      // Unused code is a bug per the build brief, not a style preference.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
