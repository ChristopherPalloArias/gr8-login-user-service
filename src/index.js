import express from 'express';
import AWS from 'aws-sdk';
import cors from 'cors';
import bcrypt from 'bcrypt';
import swaggerUi from 'swagger-ui-express';
import swaggerJsDoc from 'swagger-jsdoc';
import amqp from 'amqplib';

const app = express();
const port = 8081;

// AWS region and Lambda function configuration
const region = "us-east-2";
const lambdaFunctionName = "fetchSecretsFunction_gr8";

// Function to invoke Lambda and fetch secrets
async function getSecretFromLambda() {
  const lambda = new AWS.Lambda({ region: region });
  const params = {
    FunctionName: lambdaFunctionName,
  };

  try {
    const response = await lambda.invoke(params).promise();
    const payload = JSON.parse(response.Payload);
    if (payload.errorMessage) {
      throw new Error(payload.errorMessage);
    }
    const body = JSON.parse(payload.body);
    return JSON.parse(body.secret);
  } catch (error) {
    console.error('Error invoking Lambda function:', error);
    throw error;
  }
}

// Function to start the service
async function startService() {
  let secrets;
  try {
    secrets = await getSecretFromLambda();
  } catch (error) {
    console.error(`Error starting service: ${error}`);
    return;
  }

  app.use(cors());
  app.use(express.json());

  // Configure AWS DynamoDB
  AWS.config.update({
    region: region,
    accessKeyId: secrets.AWS_ACCESS_KEY_ID,
    secretAccessKey: secrets.AWS_SECRET_ACCESS_KEY,
  });

  const dynamoDB = new AWS.DynamoDB.DocumentClient();

  // Swagger setup
  const swaggerOptions = {
    swaggerDefinition: {
      info: {
        title: 'Login Service API',
        version: '1.0.0',
        description: 'API for user login',
      },
    },
    apis: ['./src/index.js'],
  };

  const swaggerDocs = swaggerJsDoc(swaggerOptions);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

  // Connect to RabbitMQ
  let channel;
  async function connectRabbitMQ() {
    try {
      const connection = await amqp.connect('amqp://3.136.72.14:5672/');
      channel = await connection.createChannel();
      await channel.assertQueue('user-events', { durable: true });
      console.log('Connected to RabbitMQ');
    } catch (error) {
      console.error('Error connecting to RabbitMQ:', error);
    }
  }

  await connectRabbitMQ();

  /**
   * @swagger
   * /login:
   *   post:
   *     description: Login a user
   *     parameters:
   *       - name: username
   *         description: Username of the user
   *         in: body
   *         required: true
   *         type: string
   *       - name: password
   *         description: Password of the user
   *         in: body
   *         required: true
   *         type: string
   *     responses:
   *       200:
   *         description: Login successful
   *       401:
   *         description: Invalid username or password
   */
  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const params = {
      TableName: 'UsersList_gr8', // Asegúrate de que el nombre de la tabla es correcto
      Key: {
        username: username,
      },
    };
    dynamoDB.get(params, async (err, data) => {
      if (err) {
        console.error('Error fetching user:', err);
        res.status(500).send({ message: 'Error fetching user', error: err });
        return;
      }
      if (!data.Item) {
        res.status(401).send({ success: false, message: 'Invalid username or password' });
        return;
      }
      const user = data.Item;
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        res.status(401).send({ success: false, message: 'Invalid username or password' });
        return;
      }

      // Publish login event to RabbitMQ
      const event = {
        eventType: 'UserLoggedIn',
        data: { username: user.username },
      };
      channel.sendToQueue('user-events', Buffer.from(JSON.stringify(event)));

      res.send({ success: true, message: 'Login successful' });
    });
  });

  // Root route to check if the server is running
  app.get('/', (req, res) => {
    res.send('Login Service Running');
  });

  app.listen(port, () => {
    console.log(`Login service listening at http://localhost:${port}`);
  });
}

startService();
