const crypto = require("crypto");

// Prevent dotenv from loading the real .env when index.js is re-required.
jest.mock("dotenv", () => ({
  config: jest.fn(() => ({ parsed: {} })),
}));

jest.mock("firebase-admin", () => require("./setup/firebaseAdminMock"));
jest.mock("razorpay", () => require("./setup/razorpayMock").RazorpayMock);
jest.mock("nodemailer", () => require("./setup/nodemailerMock"));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("Environment variant branches", () => {
  test("POST /webhook returns 400 when webhook secret is missing", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;

    const request = require("supertest");
    const app = require("../index");

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", "dummy-signature")
      .send(JSON.stringify({ event: "payment.captured" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid webhook");
  });

  test("verify-payment succeeds even when email credentials are missing", async () => {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;

    // keep Razorpay secret available
    process.env.RAZORPAY_KEY_SECRET =
      ORIGINAL_ENV.RAZORPAY_KEY_SECRET || "test_secret";

    const request = require("supertest");
    const fbMock = require("./setup/firebaseAdminMock");
    const { mockSendMail } = require("./setup/nodemailerMock");

    const app = require("../index");

    fbMock.__reset();
    mockSendMail.mockClear();

    fbMock.__setProduct("prod1", {
      name: "Dog Bed",
      price: 500,
      active: true,
      stock: 10,
    });

    fbMock.__setOrder("order_1", {
      razorpayOrderId: "order_1",
      status: "pending",
      couponDocId: null,
      customer: {
        firstName: "Asha",
        lastName: "K",
        email: "asha@example.com",
        phone: "9999999999",
        address: {
          line1: "A1",
          city: "Bhopal",
          state: "MP",
          pin: "462001",
        },
      },
      items: [
        {
          id: "prod1",
          name: "Dog Bed",
          qty: 1,
          price: 500,
          variant: null,
        },
      ],
    });

    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update("order_1|pay_1")
      .digest("hex");

    const res = await request(app)
      .post("/verify-payment")
      .send({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: signature,
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);

    expect(fbMock.__getOrder("order_1").status).toBe("paid");

    expect(mockSendMail).not.toHaveBeenCalled();
  });
});