# Goa touch
Configure your interaction with your computer like never before.

## Key features
- Virtual Keys
- Configure once: support Linux, Windows 10 and MacOS
- Infinite layers
- Powerfull gui
  - configure your layout
  - quickview to show/interact with layout
- Community driven

### Support variety of devices
The goal is to allow to configure any input device and configure it for all your
machines in a consistent maneer.

### Virtual Keys
Virtual keys allows you to:

1) provide a more memorable name for you keys

2) Create your own modifiers
99% of remapping/shortcut softwares does not allow you to create your own
modifiers. Having your own modifiers allow you to create more shortcuts with
fewer keystrokes that are more memorable.

3) OS agnostic
Every operating system define the key names differently, the virtual keys
provide the ability to specify the name in one oparating system that translate
to a virtual key. Therfore, you only have to define your shortuct with one
virtual key.

## Limitation
Does not support multiples mapping for the same virtual key.
If you have bind KEY_1 and KEY_2 to a virtual key (e.g. "@VIRTUAL"), if you
press KEY_1 and KEY_2, when you will release KEY_1 or KEY_2, @VIRTUAL will be
released.

## todo

- think and complete layout
  - how many layers ?
  - which keys are modifiers ?

  - rules to create new layers ?
  - rules to always be able to switch between "mouse/keyboard" and only "keyboard"

  - layer configuration vs modifier configuration
- tests
- performances
- documentation


- features
  - service launch
    - launch with systemd
    - retriver the current user and group id
    - retrive the screen

  - context aware

  - security
    - config file should be protected, otherwise any key could be remaped to a
      command that want to keylog
    - set the user and group that should launch the command

  - compatibility
    - windows
    - mac

  - observe /dev/input
  - ui
    - show current layout
    - show key modifiers
