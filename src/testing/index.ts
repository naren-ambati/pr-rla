/** `pr-rla/testing`: the provider conformance kit for third-party adapters. */
export {
  runProviderConformance,
  assertProviderConformance,
  formatConformanceReport,
  CONFORMANCE_CHECKS,
  INJECTED_RETRY_AFTER_SECONDS,
  type ConformanceCheck,
  type ConformanceFixture,
  type ConformanceHarness,
  type ConformanceReport,
  type ConformanceResult,
  type ProviderUnderTest,
} from "./conformance.js";
