MediaRemote Adapter (https://github.com/ungive/mediaremote-adapter), BSD 3-Clause License (see LICENSE).
Built from source on macOS with clang (universal arm64 + x86_64, ad-hoc signed). Used only by src/main.js on macOS to read "now playing"
and to send play/pause/next/previous to the player. It is not linked into the app: it runs through /usr/bin/perl (an Apple binary that is
allowed to use the MediaRemote framework, which macOS 15.4 and later deny to other programs).
