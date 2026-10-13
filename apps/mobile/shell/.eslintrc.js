module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      files: ['jest.setup.js', '**/*.test.ts', '**/*.test.tsx'],
      env: { jest: true },
      globals: { jest: 'readonly' },
    },
  ],
};
