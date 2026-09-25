// Shared mock for the `razorpay` package's default export (a class).
// index.js does `new Razorpay({key_id, key_secret})` once at module load,
// so every instance shares this same jest.fn — tests import
// `mockOrdersCreate` directly and set its behavior per-test.

const mockOrdersCreate = jest.fn();

class RazorpayMock {
  constructor(options) {
    this.options = options;
    this.orders = { create: mockOrdersCreate };
  }
}

module.exports = { RazorpayMock, mockOrdersCreate };