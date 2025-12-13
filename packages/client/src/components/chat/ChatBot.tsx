import axios from 'axios';
import { useRef, useState } from 'react';
import TypingIndicator from './TypingIndicator';
import type { Message } from './chatMessages';
import ChatMessages from './chatMessages';
import ChatInput, { type ChatFormData } from './chatInput';

type ChatResponse = {
   // define chat response type
   message: string;
};

// chatBot component
const chatBot = () => {
   const [Messages, setMesages] = useState<Message[]>([]);
   const [isBotTyping, setIsBotTyping] = useState(false);
   const [error, setError] = useState('');
   const conversationId = useRef(crypto.randomUUID());

   // handle form submission
   const onSubmit = async ({ prompt }: ChatFormData) => {
      try {
         setMesages((prev) => [...prev, { content: prompt, role: 'user' }]);
         setIsBotTyping(true);
         setError('');

         // send post request to chat API
         const { data } = await axios.post<ChatResponse>('/api/chat', {
            prompt,
            conversationId: conversationId.current,
         });

         setMesages((prev) => [
            ...prev,
            { content: data.message, role: 'bot' },
         ]);
         setIsBotTyping(false);
      } catch (err: any) {
         console.error(err);
         setError('somthing went wrong! please try again later.');
      } finally {
         setIsBotTyping(false);
      }
   };

   // render chat bot form
   return (
      <div className="flex flex-col  h-full">
         <div className="flex flex-col flex-1 gap-3 mb-10 overflow-y-auto">
            <ChatMessages messages={Messages} />
            {isBotTyping && <TypingIndicator />}
            {error && <p className="text-red-500">{error}</p>}
         </div>
         <ChatInput onSubmit={onSubmit} />
      </div>
   );
};

export default chatBot;
