import { Remapper } from './Remapper';
export const start = async () => {
  const remapper = new Remapper();
  await remapper.start();

  function handle() {
    remapper.unbind();

    process.off('SIGHUP', handle);
    process.off('SIGQUIT', handle);
    process.off('SIGINT', handle);
    process.off('SIGTERM', handle);
    process.exit(1);
  }

  process.on('SIGHUP', handle);
  process.on('SIGQUIT', handle);
  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
};
start();
