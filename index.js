const { MongoClient, ServerApiVersion } = require('mongodb');
const express = require('express');
const cors = require('cors')
require('dotenv').config()
const port = process.env.PORT || 5000

const app = express();
app.use(cors());
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
    await client.connect();
    // Send a ping to confirm a successful connection

    // from here start api 

    const database = client.db('bloodDonationDB');
    const userCollections = database.collection('user')
    const requestsCollection = database.collection('request')

    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'dooner';
      user.status = 'active'
      user.createAt = new Date()

      const result = await userCollections.insertOne(user);
      res.send(result)
    })


    app.get('/users/role/:email', async (req, res) => {
      const { email } = req.params

      const query = { email: email }
      const result = await userCollections.findOne(query)
      console.log(result);
      res.send(result)
    })

    app.post("/requests", verifyFBToken, async (req, res) => {
      const data = req.body;
      data.createAt = new Date();

      const result = await requestsCollection.insertOne(data);
      res.send(result);
    });


    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
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