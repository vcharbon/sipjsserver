# TODO: PCAP Replay Benchmark Tool

## Goal
Build a standalone tool that replays SIP messages from pcap captures through the parser benchmark harness.

## Out of scope for initial parser benchmark work
This is a separate effort tracked here for future implementation.

## Key challenges
- PCAP parsing (libpcap format, pcapng)
- UDP fragment reassembly (IP fragmentation, not just UDP payloads)
- Separating the pcap/fragment layer from the SIP parser layer
- Must be deployable as a standalone package (runs on secure servers where pcap data lives, not dev machines)
- Terabytes of real-world traffic available for testing

## Architecture considerations
- PCAP parsing: consider `pcap-parser` or `pcapng-parser` npm packages, or native libpcap bindings
- Fragment reassembly: need IP defragmentation before extracting UDP payloads
- Output: stream of raw SIP message buffers, one per complete UDP payload
- Should feed into the same parser benchmark harness interface
- Consider streaming approach (can't load terabytes into memory)

## Dependencies
- Parser benchmark harness must be built first (provides the parser interface to test against)
- Access to secure server with pcap data
- Deployable package format (npm pack? Docker image?)
