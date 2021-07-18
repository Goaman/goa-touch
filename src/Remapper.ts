import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { eventCodes, EventConstants, eventMap, Device, UInput, EvdevEvent } from 'nevdev';
import { spawn } from 'child_process';

const configFilePath = path.resolve(__dirname, '..', 'config', 'main.yaml');

interface KeyboardConfig {
  name: string;
  layout: string;
  include?: {
    phys?: string;
  };
}

type Keymap = [string[], string[]][];
interface SimpleKeymap {
  modifiers: string[];
  commands: string[];
}
interface KeyDefinition {
  aliases: string[];
  keymaps: SimpleKeymap[];
}
interface LayoutConfig {
  /**
   * List of layout name to add.
   */
  compile?: string[];
  keymap: Keymap;
}
interface KeymapConfig {
  [name: string]: string[][];
}

interface Config {
  manifest_version: number;
  keymaps: KeymapConfig[];
  layouts: Record<string, LayoutConfig>;
  keyboards: KeyboardConfig[];
}

function getKeyboard(config: Config, name: string): KeyboardConfig | undefined {
  return config.keyboards.find((x) => x.name === name);
}
function getLayout(config: Config, name: string): LayoutConfig | undefined {
  for (const [layoutName, layout] of Object.entries(config.layouts)) {
    if (layoutName === name) {
      return layout;
    }
  }
}

enum KeyChangeState {
  RELEASE = 0,
  PRESS = 1,
  HOLD = 2,
}

const execUID = 1000;
const execGID = 1000;

// interface CompiledMapping {
//   [key: string]: {
//     modifiers: string[];
//     commands: string[];
//   };
// }

// fs.watch(
type CompiledKeymap = Record<string, KeyDefinition>;
type CompiledKeymaps = Record<number, CompiledKeymap>;

function compileKeymaps(
  config: Config,
  devices: Device[],
  deviceIds: Map<Device, number>,
  activeLayers: string[],
): Record<number, CompiledKeymap> {
  const keymaps: CompiledKeymaps = {};
  for (const device of devices) {
    const keyboardConfig = getKeyboard(config, device.name);
    const deviceId = deviceIds.get(device);
    keymaps[deviceId] = compileKeymap(config, [keyboardConfig.layout, ...activeLayers]);
  }
  return keymaps;
}

function compileKeymap(config: Config, activeLayers: string[]): CompiledKeymap {
  const compiledLayouts = new Set<string>();
  const layoutToCompile = [...activeLayers];
  const keysDefinitions: Record<string, KeyDefinition> = {};
  let currentLayoutName: string;

  while ((currentLayoutName = layoutToCompile.pop())) {
    const layoutNamesToCompile = config.layouts[currentLayoutName].compile;
    if (layoutNamesToCompile?.length) {
      layoutToCompile.push(
        ...layoutNamesToCompile.filter(
          (x) => !compiledLayouts.has(x) && config.layouts[currentLayoutName],
        ),
      );
    }
    compiledLayouts.add(currentLayoutName);
    for (const [keyGroup, commands] of config.layouts[currentLayoutName].keymap) {
      const modifiers = [...keyGroup];
      const key = modifiers.pop();

      // Remapping of virtual keys
      const keyDefinition: KeyDefinition = keysDefinitions[key] || { aliases: [], keymaps: [] };

      const commandWithoutAliases: string[] = [];
      // TODO catch error in a nice way to not stop the remapping
      if (commands.some((x) => x.startsWith('@'))) {
        if (modifiers.length > 0) {
          throw new Error(
            'It is currently not supported to map keys with modifiers to virtual keys.',
          );
        }
        for (const command of commands) {
          if (command.startsWith('@')) {
            keyDefinition.aliases.push(command);
          } else {
            commandWithoutAliases.push(command);
          }
        }
      } else {
        commandWithoutAliases.push(...commands);
      }

      const keymap: SimpleKeymap = { modifiers, commands: commandWithoutAliases };
      keyDefinition.keymaps.push(keymap);
      keysDefinitions[key] = keyDefinition;
    }
  }
  // for (const definition of Object.values(keysDefinitions)) {
  //   definition.keymaps = definition.keymaps.reverse();
  // }
  return keysDefinitions;
}

const keyStates: Record<string, boolean> = {};
const keyDowns: Record<number, boolean> = {};
const layerState: Record<string, boolean> = {};
/**
 * A map of keycode that must be released when a particural code is pressed.
 *
 * For instance, if a key has been remaped in a particular layer, if the key is
 * not released before releasing the layer, storing the key to release is
 * required.
 */
const remapToRelease: Record<number, Set<number>> = {};

const defaultDeviceName = 'GoaTouch virtual device';

export class Remapper {
  config: Config;
  uinput: UInput;
  loadedDevices: Device[] = [];
  allDevices: Device[];
  devicesIds = new Map<Device, number>();
  lastDeviceId = 0;
  compiledKeymaps: Record<number, CompiledKeymap>;
  timeout: NodeJS.Timeout;

  async start() {
    try {
      this.config = yaml.safeLoad(fs.readFileSync(configFilePath, 'utf-8')) as Config;
      this.uinput = new UInput(defaultDeviceName);
      // this.supportKeyboards2();
      await this.loadDevices();
      await this.bind();
      this.listenConfigChange();
      this.listenInputDirChanges();
    } catch (e) {
      await this.unbind();
      console.error('error', e);
    }
  }
  supportKeyboards() {
    this.uinput.enableEventType(eventCodes.EV_SYN);
    this.uinput.enableEventCode(eventCodes.EV_SYN, eventCodes.SYN_REPORT);
    this.uinput.enableEventType(eventCodes.EV_KEY);
    for (const [constant, value] of Object.entries(eventCodes)) {
      if (constant.startsWith('KEY_') || constant.startsWith('BTN_')) {
        this.uinput.enableEventCode(eventCodes.EV_KEY, value as number);
      }
    }
  }

  supportKeyboards2(): void {
    this.uinput.enableEventType(eventCodes.EV_KEY);
    for (const [constant, value] of Object.entries(eventCodes)) {
      if (constant.startsWith('KEY_') || constant.startsWith('BTN_')) {
        this.uinput.enableEventCode(eventCodes.EV_KEY, value as number);
      }
    }
  }
  // supporMouses():   void {
  //   // this.enableEventType(eventCodes.EV_FF);
  //   this.uinput.enableEventType(eventCodes.EV_REL);
  //   for (const [constant, value] of Object.entries(eventCodes)) {
  //     if (constant.startsWith('REL_')) {
  //       this.uinput.enableEventCode(eventCodes.EV_REL, value as number, addon.NULL);
  //     }
  //   }
  //   this.uinput.enableEventType(eventCodes.EV_MSC);
  //   this.uinput.enableEventCode(eventCodes.EV_MSC, eventCodes.MSC_SCAN, addon.NULL);
  // }
  async getDevicesInConfig() {
    return this.allDevices.filter((d) => !!getKeyboard(this.config, d.name));
  }
  async loadDevices() {
    this.allDevices = await Device.all();
    for (const device of this.allDevices) {
      this.devicesIds.set(device, this.lastDeviceId++);
    }
    // for (const device of this.allDevices) {
    //   // console.log('layout:', layout);
    //   // console.log('keymap:', keymap);
    //   if (!(device.name === 'Razer Razer Naga Pro')) continue;
    //   console.log('--------------------');
    //   console.log('name::', device.name);
    //   console.log('phys::', device.phys);
    //   console.log('id_product::', device.id_product);
    //   console.log('id_vendor::', device.id_vendor);
    //   console.log('id_bustype::', device.id_bustype);
    //   console.log('id_version::', device.id_version);
    //   console.log('driver_version::', device.driver_version);
    // }
  }
  async bind() {
    let compiledKeymaps: CompiledKeymaps = {};

    const getActiveLayer = () => {
      const activeLayers = Object.entries(layerState)
        .map(([layerName, state]) => layerName && state && layerName)
        .filter((layerName) => !!layerName);
      return activeLayers;
    };

    for (const device of this.allDevices) {
      const keyboardConfig = getKeyboard(this.config, device.name);
      if (!keyboardConfig) continue;
      if (keyboardConfig.include?.phys) {
        if (!device.phys.includes(keyboardConfig.include.phys)) {
          continue;
        }
      }

      this.loadedDevices.push(device);
      const layout = getLayout(this.config, keyboardConfig.layout);
      if (!layout) {
        throw new Error(
          `Layout ${keyboardConfig.layout} does not exits.\nCreate an entry or use another layout in you config.yaml`,
        );
      }

      // If the program is called while grabbing the keyboard with a key being
      // pressed, the key will not receive the signal that it as ben released
      // because we grab the device. Wait 200ms to wait for the user to
      // release the key.
      await new Promise((resolve) => (this.timeout = setTimeout(resolve, 200)));
      device.listen();
      device.grab();

      let skipNextSync = false;
      const deviceId = this.devicesIds.get(device);

      // device.onEvent((event) => {
      //   this.uinput.write(event);
      // });
      device.onEvent((event) => {
        const type = eventMap[event.type];
        if (!type) return;
        // try to understand a bug where type is undefined.
        if (!type) throw new Error('Event type ' + event.type + ' does not exists');
        const linuxKeyNames = type.events[event.code];
        if (type.name === 'EV_KEY') {
          const keyNames = new Set<string>();
          const currentKeymaps: SimpleKeymap[] = [];

          const visitedKeys = new Set<string>();
          const visitStack = [...linuxKeyNames];
          let currentKey: string;
          while ((currentKey = visitStack.shift())) {
            // console.log('currentKey:', currentKey);
            keyNames.add(currentKey);
            visitedKeys.add(currentKey);
            const deviceCompiledKeymap = compiledKeymaps?.[deviceId];
            const keyDefinition = deviceCompiledKeymap?.[currentKey];
            if (!keyDefinition) continue;
            for (const alias of keyDefinition.aliases) {
              if (!visitedKeys.has(alias)) {
                visitStack.push(alias);
              }
            }
            currentKeymaps.push(...keyDefinition.keymaps);
          }

          for (const keyName of keyNames) {
            keyStates[keyName] = !!event.value;
          }
          keyDowns[event.code] = !!event.value;

          // if (event.value !== KeyChangeState.REPEAT) {
          //   console.log('---');
          //   for (const [key, state] of Object.entries(keyStates)) {
          //     if (state) console.log(`key ${key}`, true);
          //   }
          // }

          let commandFound = false;
          if (event.value === KeyChangeState.RELEASE) {
            const releaseCodes = remapToRelease[event.code];
            if (releaseCodes) {
              for (const code of releaseCodes) {
                const evdevEvent: EvdevEvent = {
                  type: eventCodes.EV_KEY,
                  code: code,
                  value: KeyChangeState.RELEASE,
                };
                this.uinput.write(evdevEvent);
                this.uinput.sync();
              }
            }
            remapToRelease[event.code] = undefined;
          }
          for (const keymap of currentKeymaps) {
            if (keymap.commands.length) {
              const allModifiersPressed = keymap.modifiers.every((m) => keyStates[m]);
              for (const command of keymap.commands) {
                // check if command is coniere as a key remapping
                if (event.value !== KeyChangeState.HOLD) {
                  console.log('command:', command);
                }
                let match: RegExpMatchArray;
                // Check if we remap the key
                if (allModifiersPressed && command.match(/^\s*\w+\s*$/)) {
                  commandFound = true;
                  const key = command.trim().toUpperCase() as EventConstants;
                  // const keyName = eventTypes
                  const remappedCode = eventCodes[key];
                  const nevEvent: EvdevEvent = {
                    type: eventCodes['EV_KEY'],
                    code: remappedCode,
                    value: !allModifiersPressed ? 0 : event.value,
                  };
                  remapToRelease[event.code] = remapToRelease[event.code] || new Set();
                  remapToRelease[event.code].add(remappedCode);
                  console.log('remap to:', key);
                  this.uinput.write(nevEvent);
                  this.uinput.sync();
                  // check if we want to run a shell command
                } else if (
                  (match = command.match(/^\s*>(.*)/)) &&
                  (event.value === KeyChangeState.PRESS || event.value === KeyChangeState.HOLD) &&
                  allModifiersPressed
                ) {
                  commandFound = true;
                  const shellCommand = match[1];
                  console.log('launch command:', shellCommand);

                  const process = spawn('/bin/bash', ['-c', shellCommand], {
                    uid: execUID,
                    gid: execGID,
                    // todo: make env dynamic or configurable
                    env: {
                      DISPLAY: ':0',
                      HOME: '/home/goaman',
                      USER: 'goaman',
                      LOGNAME: 'goaman',
                      XAUTHORITY: '/home/goaman/.Xauthorityt=XAUTHORITY=/home/goaman/.Xauthority',
                    },
                    detached: true,
                  });
                  process.unref();

                  // check if we want to activate/deactivate a layer
                } else if ((match = command.match(/^\s*#(.*)/))) {
                  commandFound = true;
                  if (event.value === KeyChangeState.HOLD) continue;
                  const layerName = match[1].trim();
                  layerState[layerName] = !!event.value && allModifiersPressed;

                  compiledKeymaps = compileKeymaps(
                    this.config,
                    this.loadedDevices,
                    this.devicesIds,
                    getActiveLayer(),
                  );
                }
              }
              break;
            }
          }
          if (!commandFound) {
            this.uinput.write(event);
            this.uinput.sync();
          }
          skipNextSync = true;
        } else {
          // console.log('skipNextSync:', skipNextSync);
          // console.log('type.name:', type.name);
          // // if (type.name === 'EV_SYNC') {
          // // if (!skipNextSync) this.uinput.write(event);
          // // } else {
          // // this.uinput.write(event);
          // // }
          // skipNextSync = false;
        }
      });
    }

    compiledKeymaps = compileKeymaps(
      this.config,
      this.loadedDevices,
      this.devicesIds,
      getActiveLayer(),
    );
  }
  async unbind() {
    clearTimeout(this.timeout);
    for (const [fromCode, remapedCodes] of Object.entries(remapToRelease)) {
      this.uinput.write({
        type: eventCodes.EV_KEY,
        code: parseInt(fromCode),
        value: KeyChangeState.RELEASE,
      });
      this.uinput.sync();
      if (!remapedCodes) continue;
      for (const code of remapedCodes) {
        this.uinput.write({
          type: eventCodes.EV_KEY,
          code: code,
          value: KeyChangeState.RELEASE,
        });
        this.uinput.sync();
      }
    }
    for (const device of this.loadedDevices) {
      device.ungrab();
      device.removeAllListeners();
    }
    this.loadedDevices = [];
  }

  listenConfigChange() {
    console.log('Listening change for:', configFilePath);
    fs.watch(configFilePath, () => {
      console.log('Config changed,. rebinding...');
      this.unbind();

      this.config = yaml.safeLoad(fs.readFileSync(configFilePath, 'utf-8')) as Config;
      console.log('config', this.config);
      if (this.config) this.bid();

      console.log('Rebinding done.');
    });
  }

  listenInputDirChanges() {
    const watcher = chokidar.watch('/dev/input/', {
      ignoreInitial: true,
    });

    const reset = () => {
      this.unbind();
      this.loadDevices();
      this.bind();
    };

    watcher.on('add', reset);
  }

  /**
   * Insure the config is properly defined.
   */
  validateConfig() {
    throw new Error('Implement me.');
  }
}
