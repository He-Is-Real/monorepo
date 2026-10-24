import { takeContractProblems } from './contract';

// A response that breaks api-public-read.yaml fails the test that asked for it (contract.ts).
afterEach(() => {
  expect(takeContractProblems()).toEqual([]);
});
