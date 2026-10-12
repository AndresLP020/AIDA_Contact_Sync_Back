/** Dos proyectos: "unit" (sin base de datos) y "e2e" (Nest + PostgreSQL de pruebas + GHL simulado por HTTP). */
const tsJest = { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true }] };
module.exports = {
  projects: [
    { displayName: 'unit', testEnvironment: 'node', transform: tsJest, moduleFileExtensions: ['ts', 'js'], testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    {
      displayName: 'e2e',
      testEnvironment: 'node',
      transform: tsJest,
      moduleFileExtensions: ['ts', 'js'],
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/global-setup.ts',
      setupFiles: ['<rootDir>/test/env-setup.ts'],
    },
  ],
};
