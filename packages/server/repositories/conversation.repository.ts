//implementation detail
const conversations = new Map<string, string>();

//export public inteface
export const conversationRepository = {
   // ==>   get last response id for a conversation
   getLastResponseId(conversationId: string) {
      return conversations.get(conversationId);
   },

   // ==>  set last response id for a conversation
   setLastResponseId(conversationId: string, responseId: string) {
      conversations.set(conversationId, responseId);
   },
};
