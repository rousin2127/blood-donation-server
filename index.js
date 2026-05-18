const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors')
require('dotenv').config()
const port = process.env.PORT || 5000

let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
} catch (e) {
  console.warn('Stripe not loaded:', e.message);
}

const app = express();
app.use(cors({
  origin: "*",
  credentials: true
}));

app.use(express.json())



// const serviceAccount = require("./firebase-admin-key.json");
const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_KEY_API, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});



const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'unauthorize access' })
  }
  try {
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    console.log('decoded info :', decoded)
    req.decoded_email = decoded.email
    next()
  }
  catch (error) {
    return res.status(401).send({ message: 'unauthorize access' })
  }
}





const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(
  process.env.DB_PASS
)}@${process.env.DB_HOST}/${process.env.DB_NAME}?retryWrites=true&w=majority`;

//const uri = "mongodb+srv://bloodDonation:<db_password>@cluster0.ijc2zmy.mongodb.net/?appName=Cluster0";

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    //wait client.connect();
    // Send a ping to confirm a successful connection

    // from here start api 

    const database = client.db('bloodDonationDB');
    const userCollections = database.collection('user')
    const requestsCollection = database.collection('request')
    const fundsCollection = database.collection('funds')

    const verifyAdminOrVolunteer = async (req, res, next) => {
      try {
        const requester = await userCollections.findOne({ email: req.decoded_email });
        if (!requester || !['admin', 'volunteer'].includes(requester.role)) {
          return res.status(403).send({ message: 'Forbidden' });
        }
        next();
      } catch (err) {
        console.error(err);
        return res.status(500).send({ message: 'Failed to verify role' });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      try {
        const requester = await userCollections.findOne({ email: req.decoded_email });
        if (!requester || requester.role !== 'admin') {
          return res.status(403).send({ message: 'Forbidden: admin only' });
        }
        next();
      } catch (err) {
        console.error(err);
        return res.status(500).send({ message: 'Failed to verify admin' });
      }
    };

    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = user.role || 'donor'; 
      user.status = 'active'
      user.createAt = new Date()

      const result = await userCollections.insertOne(user);
      res.send(result)
    })

    app.get('/users', verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await userCollections.find().toArray();
      res.status(200).send(result)
    })



    app.get('/users/role/:email', async (req, res) => {
      try {
        const email = decodeURIComponent(String(req.params.email || ''))

        const query = { email: email }
        const result = await userCollections.findOne(query)
        console.log(result);
        res.send(result)
      } catch (e) {
        console.error(e);
        res.status(400).send({ message: 'Invalid email parameter' });
      }
    })


    app.get('/profile', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await userCollections.findOne({ email });
      res.send(user);
    });

    app.patch('/profile', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const body = req.body || {};

        // email must never be editable
        const updateDoc = {
          $set: {
            displayName: body.displayName,
            photoURL: body.photoURL,
            district: body.district,
            upazila: body.upazila,
            blood: body.blood
          }
        };

        // remove undefined fields (avoid overwriting with undefined)
        Object.keys(updateDoc.$set).forEach((k) => {
          if (updateDoc.$set[k] === undefined) delete updateDoc.$set[k];
        });

        const result = await userCollections.updateOne({ email }, updateDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to update profile' });
      }
    });

    // public: search donors by blood group + district + upazila (spec)
    app.get('/donors', async (req, res) => {
      try {
        const bloodGroup = String(req.query.bloodGroup || '').trim();
        const district = String(req.query.district || '').trim();
        const upazila = String(req.query.upazila || '').trim();

        if (!bloodGroup || !district || !upazila) {
          return res.status(400).send({
            message: 'bloodGroup, district and upazila are required',
          });
        }

        const query = {
          status: 'active',
          blood: bloodGroup,
          district,
          upazila,
          role: { $nin: ['admin', 'volunteer'] },
        };

        const donors = await userCollections
          .find(query)
          .project({
            email: 1,
            displayName: 1,
            name: 1,
            photoURL: 1,
            district: 1,
            upazila: 1,
            blood: 1,
          })
          .toArray();

        res.send(donors);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to search donors' });
      }
    });

    // block user


    app.patch('/users/block/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: { status: 'blocked' }
        };

        const result = await userCollections.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        console.error("Error blocking user:", error);
        res.status(500).send({ message: 'Failed to block user' });
      }
    });

    // Unblock a user (update status to 'active')
    app.patch('/users/unblock/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: { status: 'active' }
        };

        const result = await userCollections.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        console.error("Error unblocking user:", error);
        res.status(500).send({ message: 'Failed to unblock user' });
      }
    });

    app.patch('/users/make-admin/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };
        const result = await userCollections.updateOne(filter, { $set: { role: 'admin' } });
        res.send(result);
      } catch (error) {
        console.error('Error make admin:', error);
        res.status(500).send({ message: 'Failed to update role' });
      }
    });

    app.patch('/users/make-volunteer/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };
        const target = await userCollections.findOne(filter);
        if (!target) {
          return res.status(404).send({ message: 'User not found' });
        }
        if (target.role !== 'donor') {
          return res.status(400).send({ message: 'Only donors can be made volunteer' });
        }
        const result = await userCollections.updateOne(filter, { $set: { role: 'volunteer' } });
        res.send(result);
      } catch (error) {
        console.error('Error make volunteer:', error);
        res.status(500).send({ message: 'Failed to update role' });
      }
    });

    app.post("/requests", verifyFBToken, async (req, res) => {
      try {
        const requesterEmail = req.decoded_email;
        const requester = await userCollections.findOne({ email: requesterEmail });
        if (!requester) {
          return res.status(404).send({ message: 'User not found' });
        }
        if (requester.status === 'blocked') {
          return res.status(403).send({ message: 'Blocked users cannot create requests' });
        }

        const data = req.body || {};
        data.requesterEmail = requesterEmail;
        data.requesterName = data.requesterName || requester.displayName || requester.name || '';
        data.status = 'pending';
        data.createAt = new Date();

        const result = await requestsCollection.insertOne(data);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to create request' });
      }
    });

    // public: pending donation requests (no auth)
    app.get('/donation-requests', async (req, res) => {
      try {
        const result = await requestsCollection
          .find({ status: 'pending' })
          .sort({ createAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to fetch donation requests' });
      }
    });

    // private: donation request details
    app.get('/donation-requests/:id', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
        if (!request) return res.status(404).send({ message: 'Not found' });
        res.send(request);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to fetch request' });
      }
    });

    // update editable fields (owner or admin) — not volunteer
    app.patch('/donation-requests/:id', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.decoded_email;
        const actor = await userCollections.findOne({ email });
        if (!actor) return res.status(404).send({ message: 'User not found' });
        if (actor.role === 'volunteer') {
          return res.status(403).send({ message: 'Volunteers cannot edit request details' });
        }

        const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
        if (!request) return res.status(404).send({ message: 'Not found' });
        const isAdmin = actor.role === 'admin';
        const isOwner = request.requesterEmail === email;
        if (!isOwner && !isAdmin) {
          return res.status(403).send({ message: 'Forbidden' });
        }

        const body = req.body || {};
        const $set = {
          recipientName: body.recipientName,
          district: body.district,
          upazila: body.upazila,
          hospitalName: body.hospitalName,
          address: body.address,
          bloodGroup: body.bloodGroup,
          donationDate: body.donationDate,
          donationTime: body.donationTime,
          message: body.message,
        };
        Object.keys($set).forEach((k) => {
          if ($set[k] === undefined) delete $set[k];
        });

        if (Object.keys($set).length === 0) {
          return res.status(400).send({ message: 'No fields to update' });
        }

        const result = await requestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set }
        );
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to update request' });
      }
    });
    app.patch('/donation-requests/:id/donate', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const donorEmail = req.decoded_email;
        const donor = await userCollections.findOne({ email: donorEmail });
        if (!donor) return res.status(404).send({ message: 'User not found' });
        if (donor.status === 'blocked') return res.status(403).send({ message: 'Blocked users cannot donate' });

        const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
        if (!request) return res.status(404).send({ message: 'Not found' });
        if (request.status !== 'pending') return res.status(400).send({ message: 'Only pending requests can be donated' });

        const updateDoc = {
          $set: {
            status: 'inprogress',
            donorName: donor.displayName || donor.name || '',
            donorEmail: donorEmail
          }
        };
        const result = await requestsCollection.updateOne({ _id: new ObjectId(id) }, updateDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to donate' });
      }
    });

    // update request status (inprogress -> done/canceled)
    app.patch('/donation-requests/:id/status', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body || {};
        if (!['done', 'canceled', 'inprogress', 'pending'].includes(status)) {
          return res.status(400).send({ message: 'Invalid status' });
        }

        const email = req.decoded_email;
        const requester = await userCollections.findOne({ email });
        if (!requester) return res.status(404).send({ message: 'User not found' });

        const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
        if (!request) return res.status(404).send({ message: 'Not found' });

        const isAdmin = requester.role === 'admin';
        const isVolunteer = requester.role === 'volunteer';
        const isOwner = request.requesterEmail === email;

        // volunteer: only status update allowed
        if (isVolunteer) {
          const result = await requestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );
          return res.send(result);
        }

        // donor/admin: must be owner or admin
        if (!isOwner && !isAdmin) {
          return res.status(403).send({ message: 'Forbidden' });
        }

        // admin: any valid status
        if (isAdmin) {
          const result = await requestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );
          return res.send(result);
        }

        // donor (owner, not admin): only done or canceled, and only from inprogress
        if (!['done', 'canceled'].includes(status)) {
          return res.status(400).send({
            message: 'Donors may only set status to done or canceled',
          });
        }
        if (request.status !== 'inprogress') {
          return res.status(400).send({
            message: 'Only in-progress requests can be marked done or canceled',
          });
        }

        const result = await requestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );
        return res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to update status' });
      }
    });

    // delete request (owner or admin)
    app.delete('/donation-requests/:id', verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.decoded_email;
        const requester = await userCollections.findOne({ email });
        if (!requester) return res.status(404).send({ message: 'User not found' });
        if (requester.role === 'volunteer') {
          return res.status(403).send({ message: 'Volunteers cannot delete donation requests' });
        }

        const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
        if (!request) return res.status(404).send({ message: 'Not found' });

        const isAdmin = requester.role === 'admin';
        const isOwner = request.requesterEmail === email;
        if (!isOwner && !isAdmin) return res.status(403).send({ message: 'Forbidden' });

        const result = await requestsCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to delete request' });
      }
    });

    // my request page 
    app.get('/my-donation-requests', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const size = Number(req.query.size) || 5;
        const page = Number(req.query.page) || 0;
        const status = req.query.status; // optional

        const query = {
          requesterEmail: email
        };

        // apply status filter if provided
        if (status && status !== 'all') {
          query.status = status;
        }

        const result = await requestsCollection
          .find(query)
          .limit(size)
          .skip(size * page)
          .toArray();

        const totalRequest = await requestsCollection.countDocuments(query);

        res.send({ request: result, totalRequest });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to fetch donation requests' });
      }
    });

    // --- Dashboard stats (admin + volunteer home cards) ---
    app.get('/dashboard-stats', verifyFBToken, verifyAdminOrVolunteer, async (req, res) => {
      try {
        const totalDonors = await userCollections.countDocuments({
          role: { $nin: ['admin', 'volunteer'] },
        });
        const fundsAgg = await fundsCollection
          .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
          .toArray();
        const totalFunds = fundsAgg[0]?.total || 0;
        const totalRequests = await requestsCollection.countDocuments({});
        res.send({ totalDonors, totalFunds, totalRequests });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to load stats' });
      }
    });

    // --- All donation requests (admin + volunteer) ---
    app.get('/all-donation-requests', verifyFBToken, verifyAdminOrVolunteer, async (req, res) => {
      try {
        const status = req.query.status;
        const query = {};
        if (status && status !== 'all') query.status = status;
        const list = await requestsCollection
          .find(query)
          .sort({ createAt: -1 })
          .toArray();
        res.send(list);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to fetch requests' });
      }
    });

    // --- Funding (Stripe) ---
    app.get('/funding', verifyFBToken, async (req, res) => {
      try {
        const funds = await fundsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        const agg = await fundsCollection
          .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
          .toArray();
        const totalAmount = agg[0]?.total || 0;
        res.send({ funds, totalAmount });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to fetch funds' });
      }
    });

    app.post('/funding/create-payment-intent', verifyFBToken, async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).send({ message: 'Stripe is not configured (STRIPE_SECRET_KEY)' });
        }
        const amountUsd = Number(req.body?.amount);
        if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 5000) {
          return res.status(400).send({ message: 'Amount must be between 1 and 5000 (USD)' });
        }
        const donor = await userCollections.findOne({ email: req.decoded_email });
        if (!donor || donor.status === 'blocked') {
          return res.status(403).send({ message: 'Cannot create payment' });
        }
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amountUsd * 100),
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
          metadata: {
            donorEmail: req.decoded_email,
          },
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: error.message || 'Failed to create payment' });
      }
    });

    app.post('/funding/confirm', verifyFBToken, async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).send({ message: 'Stripe is not configured' });
        }
        const paymentIntentId = String(req.body?.paymentIntentId || '');
        if (!paymentIntentId) {
          return res.status(400).send({ message: 'paymentIntentId required' });
        }
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status !== 'succeeded') {
          return res.status(400).send({ message: 'Payment not completed' });
        }
        if (pi.metadata?.donorEmail !== req.decoded_email) {
          return res.status(403).send({ message: 'Payment does not belong to this user' });
        }
        const existing = await fundsCollection.findOne({ paymentIntentId });
        if (existing) {
          return res.send({ inserted: false, fund: existing });
        }
        const userDoc = await userCollections.findOne({ email: req.decoded_email });
        const amountUsd = (pi.amount_received || pi.amount || 0) / 100;
        const doc = {
          donorEmail: req.decoded_email,
          donorName: userDoc?.displayName || userDoc?.name || '',
          amount: amountUsd,
          currency: pi.currency || 'usd',
          paymentIntentId,
          createdAt: new Date(),
        };
        await fundsCollection.insertOne(doc);
        res.send({ inserted: true, fund: doc });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: error.message || 'Failed to confirm payment' });
      }
    });








    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    //await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Blood Donation')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})