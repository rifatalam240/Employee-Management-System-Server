require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const Stripe = require("stripe");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Client
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

// Stripe Initialization
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Collections (later assign in run function)
let userCollection;
let worksheetCollection;
let paymentCollection;
let messagesCollection;

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
  }),
});

// Middleware: Verify Firebase Token
const verifyFirebaseToken = async (req, res, next) => {
  const authheader = req.headers.authorization;
  if (!authheader || !authheader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized token" });
  }
  const token = authheader.split(" ")[1];
  try {
    const decodedtoken = await admin.auth().verifyIdToken(token);
    req.decodedtoken = decodedtoken;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
};

// Middleware: Role Based Access Control
const checkRole = (requiredRole) => {
  return async (req, res, next) => {
    const email = req.decodedtoken?.email;
    const user = await userCollection.findOne({ email });
    if (!user) return res.status(404).send({ message: "User not found" });
    if (user.role !== requiredRole)
      return res.status(403).send({ message: "Access denied" });
    next();
  };
};

// Main async function to run the server logic
async function run() {
  try {
    // await client.connect();
    console.log("✅ MongoDB Connected");

    const database = client.db("company");
    userCollection = database.collection("users");
    worksheetCollection = database.collection("worksheets");
    paymentCollection = database.collection("payments");
    messagesCollection = database.collection("messages");

    // ===== User APIs =====

    // Add new user
    app.post("/users", async (req, res) => {
      const user = req.body;
      const exists = await userCollection.findOne({ email: user.email });
      if (exists)
        return res.status(409).send({ message: "User already exists" });
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // Get dashboard summary (HR or Admin)
    app.get(
      "/dashboard-summary",
      verifyFirebaseToken,
      checkRole("hr"), // or "admin"
      async (req, res) => {
        try {
          const totalEmployees = await userCollection.countDocuments({
            role: "employee",
          });

          const totalPaidSalaryAgg = await paymentCollection
            .aggregate([
              { $match: { paid: true } },
              { $group: { _id: null, totalPaid: { $sum: "$amount" } } },
            ])
            .toArray();

          const totalPaidSalary = totalPaidSalaryAgg[0]?.totalPaid || 0;

          const totalSalaryAgg = await userCollection
            .aggregate([
              { $match: { role: "employee" } },
              { $group: { _id: null, totalSalary: { $sum: "$salary" } } },
            ])
            .toArray();

          const totalSalary = totalSalaryAgg[0]?.totalSalary || 0;

          const pendingSalary = totalSalary - totalPaidSalary;

          const recentPayments = await paymentCollection
            .find({ paid: true })
            .sort({ payDate: -1 })
            .limit(5)
            .toArray();

          res.send({
            totalEmployees,
            totalSalary,
            totalPaidSalary,
            pendingSalary,
            recentPayments,
          });
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to fetch dashboard summary" });
        }
      }
    );

    // Get single user by email
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send(user);
    });

    // Get all users or filter by email
    app.get("/users", async (req, res) => {
      const email = req.query.email;
      if (email) {
        const user = await userCollection.findOne({ email });
        return res.send(user ? [user] : []);
      }
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    // Get user role by email
    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || null });
    });

    // Get employees only
    app.get("/employees", async (req, res) => {
      try {
        const employees = await userCollection
          .find({ role: "employee" })
          .toArray();
        res.send(employees);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch employees" });
      }
    });

    // Get verified users (Admin only)
    app.get(
      "/verified-users",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        try {
          const users = await userCollection
            .find({ isVerified: true })
            .toArray();
          res.send(users);
        } catch (error) {
          res.status(500).send({ message: "Failed to fetch verified users" });
        }
      }
    );

    // Update user role (Admin only)
    app.patch(
      "/users/role/:id",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;
        try {
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update role" });
        }
      }
    );

    // Toggle verification (HR only)
    app.patch(
      "/users/verify/:id",
      verifyFirebaseToken,
      checkRole("hr"),
      async (req, res) => {
        const id = req.params.id;
        const { isVerified } = req.body;
        try {
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isVerified } }
          );
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update verification" });
        }
      }
    );

    // Delete user (Admin only)
    app.delete(
      "/users/:id",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        const id = req.params.id;
        try {
          const result = await userCollection.deleteOne({
            _id: new ObjectId(id),
          });
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to delete user" });
        }
      }
    );

    // Update salary (Admin only) - only increase allowed
    app.patch(
      "/update-salary/:id",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        const id = req.params.id;
        const { salary } = req.body;
        try {
          const user = await userCollection.findOne({ _id: new ObjectId(id) });
          if (!user) return res.status(404).send({ message: "User not found" });
          if (salary < user.salary)
            return res
              .status(400)
              .send({ message: "Salary cannot be decreased" });

          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { salary } }
          );
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update salary" });
        }
      }
    );

    // ===== Worksheet APIs =====

    // Add new work entry
    app.post("/works", async (req, res) => {
      const workData = req.body;

      const cleanedData = {
        ...workData,
        hours: parseFloat(workData.hours),
        date: new Date(workData.date),
      };

      const result = await worksheetCollection.insertOne(cleanedData);
      res.send(result);
    });

    // Get work entries with optional filtering by email, month, year
    app.get("/works", async (req, res) => {
      const { email, month, year } = req.query;
      const query = {};

      if (email) query.email = email;

      if (month && year) {
        const m = parseInt(month);
        const y = parseInt(year);

        if (!isNaN(m) && !isNaN(y)) {
          const startDate = new Date(y, m - 1, 1);
          const endDate = new Date(y, m, 1);
          query.date = { $gte: startDate, $lt: endDate };
        }
      }

      try {
        const works = await worksheetCollection
          .find(query)
          .sort({ date: -1 })
          .toArray();
        res.send(works);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch work entries" });
      }
    });

    // Update work entry by ID
    app.patch("/works/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const result = await worksheetCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData }
      );
      res.send(result);
    });

    // Delete work entry by ID
    app.delete("/works/:id", async (req, res) => {
      const id = req.params.id;
      const result = await worksheetCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // ===== Stripe Payment Intent =====
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body; // Amount in BDT expected
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount * 100, // Convert to paisa
          currency: "bdt",
          payment_method_types: ["card"],
        });
        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to create payment intent" });
      }
    });

    // ===== Payments API (HR only) with duplicate prevention =====
    app.post(
      "/payments",
      verifyFirebaseToken,
      checkRole("hr"),
      async (req, res) => {
        let { email, month, year, amount, transactionId } = req.body;

        if (typeof month === "string") {
          try {
            month = new Date(`${month} 1, ${year}`).getMonth() + 1;
          } catch (error) {
            return res.status(400).send({
              message: "Invalid month format. Use valid month name or number.",
            });
          }
        }

        year = parseInt(year);

        if (!email || !month || !year || !amount || !transactionId) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        try {
          // Check duplicate payment request for same month/year
          const existingPayment = await paymentCollection.findOne({
            email,
            month,
            year,
          });

          if (existingPayment) {
            return res.status(409).send({
              message:
                "Payment request already exists for this employee in this month and year",
            });
          }

          const result = await paymentCollection.insertOne({
            email,
            amount,
            transactionId,
            paid: false, // Payment requested, not paid yet
            month,
            year,
            payDate: null,
            requestedAt: new Date(),
          });

          res.send(result);
        } catch (error) {
          console.error("Failed to process payment request:", error);
          res.status(500).send({
            message: "Failed to process payment request",
            error: error.message,
          });
        }
      }
    );
    app.delete("/deleteAllPayments", async (req, res) => {
      try {
        const result = await paymentCollection.deleteMany({});
        console.log("Deleted payments count:", result.deletedCount); // লগে দেখাবে
        res.send({
          message: "All payments deleted",
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        console.error("Failed to delete payments:", error.message);
        res
          .status(500)
          .send({ message: "Failed to delete payments", error: error.message });
      }
    });

    app.post(
      "/paymentsbyadmin",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        const { email, amount, transactionId, month, year, paid } = req.body;

        if (!email || !amount || !transactionId || !month || !year) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        try {
          // ✅ Step 1: Check if payment already exists
          const existingPayment = await paymentCollection.findOne({
            email,
            month,
            year,
            paid: true,
          });

          if (existingPayment) {
            return res.status(400).send({
              message: "Payment already exists for this employee and month.",
            });
          }

          // ✅ Step 2: Insert payment if not exists
          const result = await paymentCollection.insertOne({
            email,
            amount,
            transactionId,
            month,
            year,
            paid,
            payDate: new Date(),
          });

          res.send({ message: "Payment saved", result });
        } catch (err) {
          res
            .status(500)
            .send({ message: "Failed to save payment", error: err.message });
        }
      }
    );

    // Get payment history with pagination
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const page = parseInt(req.query.page) || 0;
      const limit = parseInt(req.query.limit) || 5;

      const query = { email };
      const total = await paymentCollection.countDocuments(query);

      const payments = await paymentCollection
        .find(query)
        .sort({ year: 1, month: 1 })
        .skip(page * limit)
        .limit(limit)
        .toArray();

      res.send({ payments, total });
    });

    // Get all payroll data (Admin only)
    app.get(
      "/payroll",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        try {
          const allPayroll = await paymentCollection.find({}).toArray();
          res.send(allPayroll);
        } catch (error) {
          res.status(500).send({ message: "Failed to fetch payroll data" });
        }
      }
    );

    // Get verified users (Admin only)
    app.get(
      "/verified-users",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        try {
          const users = await userCollection
            .find({ isVerified: true })
            .toArray();
          res.send(users);
        } catch (error) {
          res.status(500).send({ message: "Failed to fetch verified users" });
        }
      }
    );

    // Promote user to HR (Admin only)
    app.patch(
      "/make-hr/:id",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        try {
          const id = req.params.id;
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role: "hr" } }
          );
          res.send(result);
        } catch (err) {
          res.status(500).send({ message: "Failed to make HR" });
        }
      }
    );

    // Fire user (Admin only)
    app.patch(
      "/fire-user/:id",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        try {
          const id = req.params.id;
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isFired: true } }
          );
          res.send(result);
        } catch (err) {
          res.status(500).send({ message: "Failed to fire user" });
        }
      }
    );

    // Save contact message (Anyone)
    app.post("/contact-messages", async (req, res) => {
      const { email, message } = req.body;
      if (!email || !message) return res.status(400).send("Missing fields");

      await messagesCollection.insertOne({ email, message, time: new Date() });
      res.send({ success: true });
    });

    // Admin fetches all contact messages
    app.get("/admin/messages", async (req, res) => {
      const result = await messagesCollection
        .find()
        .sort({ time: -1 })
        .toArray();
      res.send(result);
    });

    // Approve payment (Admin only)
    // app.patch(
    //   "/payroll/pay/:id",
    //   verifyFirebaseToken,
    //   checkRole("admin"),
    //   async (req, res) => {
    //     const id = req.params.id;
    //     const payDate = new Date();
    //     try {
    //       const result = await paymentCollection.updateOne(
    //         { _id: new ObjectId(id) },
    //         { $set: { paid: true, approved: true, payDate } }
    //       );
    //       res.send(result);
    //     } catch (error) {
    //       res.status(500).send({ message: "Failed to approve payment" });
    //     }
    //   }
    // );
    // Approve payment (Admin only) - আগের সাধারণ পেমেন্ট আপডেট (কমেন্ট করা আছে)
    // app.patch(
    //   "/payroll/pay/:id",
    //   verifyFirebaseToken,
    //   checkRole("admin"),
    //   async (req, res) => {
    //     const id = req.params.id;
    //     const payDate = new Date();
    //     try {
    //       const result = await paymentCollection.updateOne(
    //         { _id: new ObjectId(id) },
    //         { $set: { paid: true, approved: true, payDate } }
    //       );
    //       res.send(result);
    //     } catch (error) {
    //       res.status(500).send({ message: "Failed to approve payment" });
    //     }
    //   }
    // );

    // নতুন: Stripe payment confirm করে পেমেন্ট ডাটাবেজে আপডেট করা
    app.patch(
      "/payroll/pay/:id",
      verifyFirebaseToken,
      checkRole("admin"),
      async (req, res) => {
        const id = req.params.id;
        const { paymentIntentId } = req.body;

        if (!paymentIntentId) {
          return res
            .status(400)
            .send({ message: "paymentIntentId is required" });
        }

        try {
          // Stripe এ paymentIntent কনফার্ম করা
          const paymentIntent = await stripe.paymentIntents.confirm(
            paymentIntentId
          );

          if (paymentIntent.status !== "succeeded") {
            return res.status(400).send({ message: "Payment not successful" });
          }

          // সফল পেমেন্ট হলে ডাটাবেজ আপডেট
          const payDate = new Date();
          const result = await paymentCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                paid: true,
                approved: true,
                payDate,
                transactionId: paymentIntent.id, // Stripe transaction ID
              },
            }
          );

          res.send({
            message: "Payment successful and payroll updated",
            paymentIntent,
            dbUpdateResult: result,
          });
        } catch (error) {
          console.error("Stripe payment failed:", error);
          res.status(500).send({
            message: "Failed to process payment",
            error: error.message,
          });
        }
      }
    );

    // Add more APIs as needed here...
  } catch (err) {
    console.error("MongoDB error:", err);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("🚀 Employee Management Server Running");
});

app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
