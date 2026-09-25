# Backend Testing

This repository contains the automated testing suite developed for the VASTU Store Backend.

## Overview

The objective was to improve the reliability and stability of the backend by writing comprehensive unit and integration tests covering all major API endpoints and critical business logic.

## Test Coverage

- ✅ 57 Automated Test Cases
- ✅ 7 Test Suites
- ✅ 98.51% Statement Coverage
- ✅ 85% Branch Coverage
- ✅ 95% Function Coverage
- ✅ 98.42% Line Coverage

## APIs Covered

- Health Check
- Create Order
- Validate Coupon
- Verify Payment
- Payment Failed
- Razorpay Webhooks
- Environment & Configuration Variants

## Tested Scenarios

- Successful order creation
- Invalid and empty cart handling
- Product validation
- Stock verification
- Coupon validation
- Razorpay payment verification
- Webhook signature validation
- Payment success & failure flows
- Firestore failure handling
- Email delivery success/failure
- Environment variable edge cases
- Security and validation checks

## Tech Stack

- Jest
- Supertest
- Firebase Admin Mock
- Express.js

## Result

```
Test Suites: 7 passed
Tests:       57 passed
Coverage:
Statements : 98.51%
Branches   : 85%
Functions  : 95%
Lines      : 98.42%
```

---

Developed and maintained the complete backend testing suite to ensure API reliability, business logic validation, and regression safety.