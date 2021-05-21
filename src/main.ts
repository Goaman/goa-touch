import { Remapper } from './Remapper';
import { start } from './remapperMain';
import * as fs from 'fs';
import * as chokidar from 'chokidar';

start();

// fs.watchFile('/dev/input', { interval: 1000 }, (curr, prev) => {
//   console.log('/dev/input folder change: curr, prev:', curr, prev);
//   // console.log(`${buttonPressesLogFile} file Changed`);
// });

// const watcher = chokidar.watch('/dev/input', {
//   persistent: true,
// });

// watcher
//   .on('add', (path) => console.log(`File ${path} has been added`))
//   .on('change', (path) => console.log(`File ${path} has been changed`))
//   .on('unlink', (path) => console.log(`File ${path} has been removed`))
