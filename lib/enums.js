// Canonical enums for the QueueStorm classifier.
// Single source of truth — used by the rules engine, the Gemini responseSchema,
// and the response validator. Do not duplicate these strings elsewhere.

const CASE_TYPES = [
  "wrong_transfer",
  "payment_failed",
  "refund_request",
  "phishing_or_social_engineering",
  "other",
];

const SEVERITIES = ["low", "medium", "high", "critical"];

const DEPARTMENTS = [
  "customer_support",
  "dispute_resolution",
  "payments_ops",
  "fraud_risk",
];

// case_type -> default department (per spec section 4.2).
const DEPT_BY_CASE = {
  wrong_transfer: "dispute_resolution",
  payment_failed: "payments_ops",
  refund_request: "customer_support", // dispute_resolution only when contested
  phishing_or_social_engineering: "fraud_risk",
  other: "customer_support",
};

// case_type -> default severity baseline.
const SEVERITY_BY_CASE = {
  phishing_or_social_engineering: "critical",
  wrong_transfer: "high",
  payment_failed: "high",
  refund_request: "low",
  other: "low",
};

module.exports = {
  CASE_TYPES,
  SEVERITIES,
  DEPARTMENTS,
  DEPT_BY_CASE,
  SEVERITY_BY_CASE,
};
