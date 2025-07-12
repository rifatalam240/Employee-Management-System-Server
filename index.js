require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
var admin = require("firebase-admin");

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

let userCollection; // Declare globally for role check middleware

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
  }),
});

const verifyfirebasetoken = async (req, res, next) => {
  const authheader = req.headers.authorization;
  if (!authheader || !authheader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "unauthorized token" });
  }
  const token = authheader.split(" ")[1];
  try {
    const decodedtoken = await admin.auth().verifyIdToken(token);
    req.decodedtoken = decodedtoken;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const checkRole = (requiredRole) => {
  return async (req, res, next) => {
    const email = req.decodedtoken?.email;
    const user = await userCollection.findOne({ email });
    if (!user) return res.status(404).send({ message: "User not found" });
    if (user.role !== requiredRole) return res.status(403).send({ message: "Access denied" });
    next();
  };
};

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected");

    const database = client.db("company");
    userCollection = database.collection("users");
    const worksheetCollection = database.collection("worksheets");
    const paymentCollection = database.collection("payments");

    app.post("/users", async (req, res) => {
      const user = req.body;
      const exists = await userCollection.findOne({ email: user.email });
      if (exists) return res.status(409).send({ message: "User already exists" });
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send(user);
    });

    app.get("/users", async (req, res) => {
      const email = req.query.email;
      if (email) {
        const user = await userCollection.findOne({ email });
        return res.send(user ? [user] : []);
      }
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || null });
    });

    app.get("/employees", async (req, res) => {
      try {
        const employees = await userCollection.find({ role: "employee" }).toArray();
        res.send(employees);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch employees" });
      }
    });

    app.patch("/users/role/:id", async (req, res) => {
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
    });

    app.patch("/users/verify/:id", async (req, res) => {
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
    });

    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete user" });
      }
    });

    app.get("/verified-users", async (req, res) => {
      try {
        const users = await userCollection.find({ isVerified: true, role: { $ne: "admin" } }).toArray();
        res.send(users);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch verified users" });
      }
    });

    app.patch("/make-hr/:id", verifyfirebasetoken, checkRole("admin"), async (req, res) => {
      const id = req.params.id;
      try {
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: "hr" } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to make HR" });
      }
    });

    app.patch("/fire-user/:id", verifyfirebasetoken, checkRole("admin"), async (req, res) => {
      const id = req.params.id;
      try {
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isFired: true } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fire user" });
      }
    });

    app.patch("/update-salary/:id", verifyfirebasetoken, checkRole("admin"), async (req, res) => {
      const id = req.params.id;
      const { salary } = req.body;
      try {
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { salary } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update salary" });
      }
    });

    app.post("/works", async (req, res) => {
      const workData = req.body;
      const result = await worksheetCollection.insertOne(workData);
      res.send(result);
    });

    app.get("/works", async (req, res) => {
      const { email, month, year } = req.query;
      const query = {};
      if (email) query.email = email;
      if (month && year) {
        const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
        const endDate = new Date(parseInt(year), parseInt(month), 1);
        query.date = { $gte: startDate, $lt: endDate };
      }
      try {
        const works = await worksheetCollection.find(query).sort({ date: -1 }).toArray();
        res.send(works);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch work entries" });
      }
    });

    app.patch("/works/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const result = await worksheetCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData }
      );
      res.send(result);
    });

    app.delete("/works/:id", async (req, res) => {
      const id = req.params.id;
      const result = await worksheetCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.post("/payments", async (req, res) => {
      const payment = req.body;
      const result = await paymentCollection.insertOne(payment);
      res.send(result);
    });

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

    app.get("/payroll", verifyfirebasetoken, checkRole("admin"), async (req, res) => {
      try {
        const unpaid = await paymentCollection.find({ paid: { $ne: true } }).toArray();
        res.send(unpaid);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch payroll data" });
      }
    });

    app.patch("/payroll/pay/:id", verifyfirebasetoken, checkRole("admin"), async (req, res) => {
      const id = req.params.id;
      const payDate = new Date();
      try {
        const result = await paymentCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { paid: true, payDate } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to approve payment" });
      }
    });
    //create payment intent//


app.post("/create-payment-intent", async (req, res) => {
  const { amount } = req.body; // amount in BDT

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amount * 100, // convert to paisa
    currency: "bdt",
    payment_method_types: ["card"],
  });

  res.send({
    clientSecret: paymentIntent.client_secret,
  });
});
app.post("/payments", verifyfirebasetoken, checkRole("hr"), async (req, res) => {
  const { email, month, year, amount, transactionId } = req.body;

  if (!email || !month || !year || !amount || !transactionId) {
    return res.status(400).send({ message: "Missing required fields" });
  }

  try {
    // Check for existing payment for same user/month/year
    const existingPayment = await paymentCollection.findOne({
      email,
      month,
      year,
      paid: true,
    });

    if (existingPayment) {
      return res.status(409).send({
        message: "Payment already exists for this employee in this month and year",
      });
    }

    // Otherwise, insert payment
    const result = await paymentCollection.insertOne({
      email,
      amount,
      transactionId,
      paid: true,
      month,
      year,
      payDate: new Date(),
    });

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to process payment" });
  }
});


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
