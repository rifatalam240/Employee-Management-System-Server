require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected");

    const database = client.db("company");
    const userCollection = database.collection("users");
    const worksheetCollection = database.collection("worksheets");
    const paymentCollection = database.collection("payments");

    // ---------------------------
    // User APIs
    // ---------------------------

    // Create user
    app.post("/users", async (req, res) => {
      const user = req.body;
      const exists = await userCollection.findOne({ email: user.email });
      if (exists) {
        return res.status(409).send({ message: "User already exists" });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // Get user by email
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send(user);
    });

    // Get all users or filter by email query param
    app.get("/users", async (req, res) => {
      const email = req.query.email;
      if (email) {
        const user = await userCollection.findOne({ email });
        return res.send(user ? [user] : []);
      }
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    // Get role by email
    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || null });
    });

    // Get only employees
    app.get("/employees", async (req, res) => {
      try {
        const employees = await userCollection.find({ role: "employee" }).toArray();
        res.send(employees);
      } catch (error) {
        console.error("Error fetching employees:", error);
        res.status(500).send({ message: "Failed to fetch employees" });
      }
    });

    // Update user role
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
        console.error("Error updating role:", error);
        res.status(500).send({ message: "Failed to update role" });
      }
    });

    // Update verification status
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
        console.error("Error updating verification:", error);
        res.status(500).send({ message: "Failed to update verification" });
      }
    });

    // Delete user
    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).send({ message: "Failed to delete user" });
      }
    });

    // ---------------------------
    // Worksheet APIs (Work entries by employees)
    // ---------------------------

    // Add work entry
    app.post("/works", async (req, res) => {
      const workData = req.body;
      const result = await worksheetCollection.insertOne(workData);
      res.send(result);
    });

    // Get work entries (with optional filters: email, month, year)
    app.get("/works", async (req, res) => {
      const { email, month, year } = req.query;

      const query = {};

      if (email) {
        query.email = email;
      }

      if (month && year) {
        const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
        const endDate = new Date(parseInt(year), parseInt(month), 1);

        query.date = { $gte: startDate, $lt: endDate };
      }

      try {
        const works = await worksheetCollection.find(query).sort({ date: -1 }).toArray();
        res.send(works);
      } catch (error) {
        console.error("Error fetching works:", error);
        res.status(500).send({ message: "Failed to fetch work entries" });
      }
    });

    // Update work entry
    app.patch("/works/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const result = await worksheetCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData }
      );
      res.send(result);
    });

    // Delete work entry
    app.delete("/works/:id", async (req, res) => {
      const id = req.params.id;
      const result = await worksheetCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // ---------------------------
    // Payment APIs
    // ---------------------------

    // Add payment (by HR)
    app.post("/payments", async (req, res) => {
      const payment = req.body;
      const result = await paymentCollection.insertOne(payment);
      res.send(result);
    });

    // Get payments (with pagination) for an employee
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const page = parseInt(req.query.page) || 0;
      const limit = parseInt(req.query.limit) || 5;

      const query = { email };
      const total = await paymentCollection.countDocuments(query);

      const payments = await paymentCollection
        .find(query)
        .sort({ year: 1, month: 1 }) // Earliest month first
        .skip(page * limit)
        .limit(limit)
        .toArray();

      res.send({ payments, total });
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
