#!/bin/sh
echo "hello from a script run by $(readlink /proc/$$/exe)"
