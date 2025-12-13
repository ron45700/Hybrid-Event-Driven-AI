import fs from 'fs';
import path from 'path';
import { conversationRepository } from '../repositories/conversation.repository';
import { OpenAI } from 'openai';
import template from '../prompts/chatbot.txt';

// Initialize detail
const client = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

const parkInfo = fs.readFileSync(
   path.join(__dirname, '..', 'prompts', 'Digital_Playground_System_Prompt.md'),
   'utf-8'
);
const instructions = template.replace('{{parkInfo}}', parkInfo);

// Define chat response type
type chatResponse = {
   id: string;
   message: string;
};

//public interface
//Leaky abstraction
export const chatService = {
   // Chat service methods would go here
   async sendMessage(
      prompt: string,
      conversationId: string
   ): Promise<chatResponse> {
      const response = await client.responses.create({
         model: 'gpt-4o-mini',
         instructions,
         input: prompt,
         temperature: 0.2,
         max_output_tokens: 100,
         previous_response_id:
            conversationRepository.getLastResponseId(conversationId),
      });

      // Store the latest response ID for the conversation
      conversationRepository.setLastResponseId(conversationId, response.id);

      // Return the chat response
      return {
         id: response.id,
         message: response.output_text,
      };
   },
};
