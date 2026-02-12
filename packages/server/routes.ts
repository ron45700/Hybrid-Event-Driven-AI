import express from 'express';
import type { Request, Response } from 'express';
import { kafkaChatController } from './controllers/kafka-chat.controller';

const router = express.Router();

router.get('/', (req: Request, res: Response) => {
   res.send('Hello, World!');
});

router.get('/api/hello', (req: Request, res: Response) => {
   res.json({ message: 'Hello World!' });
});

// Chat route (via Kafka)
router.post('/api/chat', kafkaChatController.handleChat);

export default { router };
