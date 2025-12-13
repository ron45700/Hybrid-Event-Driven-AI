import { Button } from '../ui/button';
import { FaArrowUp } from 'react-icons/fa';
import { useForm } from 'react-hook-form';
import type { KeyboardEvent } from 'react';

export type ChatFormData = {
   prompt: string;
};

type Props = {
   onSubmit: (data: ChatFormData) => void;
};

const chatInput = ({ onSubmit }: Props) => {
   const { register, handleSubmit, reset, formState } = useForm<ChatFormData>(); // initialize form of react-hook-form

   const submit = handleSubmit((data) => {
      reset({ prompt: '' });
      onSubmit(data);
   });

   const handleKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault(); // prevent default newline behavior
         submit(); // submit the form
      }
   };

   return (
      <form
         onSubmit={submit}
         onKeyDown={handleKeyDown} // handle keydown events
         className="flex flex-col gap-2 items-end border-2 p-4 rounded-3xl"
      >
         <textarea // textarea for user input
            {...register('prompt', {
               // register prompt field with validation rules
               required: true, // field is required
               validate: (value) => value.trim().length > 0, // prevent only whitespace inputs
            })}
            autoFocus
            className="w-full border-0 focus:outline-0 resize-none"
            placeholder="ask anything..."
            maxLength={1000}
         />
         <Button
            disabled={!formState.isValid} // disable button if form is invalid
            className="rounded-full w-9 h-9"
         >
            <FaArrowUp />
         </Button>
      </form>
   );
};

export default chatInput;
