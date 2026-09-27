module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  roots: ['<rootDir>/__tests__', '<rootDir>/src', '<rootDir>/../src'],
  // Only the shell's own tests; the core's *.test.ts use node:test.
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
  moduleNameMapper: {
    '^@greenguard/mobile-core$': '<rootDir>/../src/index.ts',
    // Core files import siblings as "./x.js" (NodeNext); map to the .ts source.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
