import { Remapper } from './Remapper';
export const start = async () => {
  const remapper = new Remapper();
  await remapper.start();
};
start();
