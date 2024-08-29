// /** @type {import('ts-jest').JestConfigWithTsJest} */
// module.exports = {
//     testEnvironment: 'node',
//     modulePathIgnorePatterns: ["<rootDir>/dist/"],
//     transformIgnorePatterns: ["/node_modules/(?!(@noble/ed25519)/)"],
//   };

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    modulePathIgnorePatterns: ['<rootDir>/dist/'],
    transformIgnorePatterns: ["/node_modules/(?!(@noble/ed25519)/)"],
    testTimeout: 10000,
  };