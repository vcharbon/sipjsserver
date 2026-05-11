---
name: sipp
description: use when working with sipp tool and write sipp .xml
---

Project uses SIP v3.7.7

When writing sipp .xml 

- always make sure SIP from/to are consistant inside dialog
- increase CSEQ by exactly one between SIP transaction
- **ACK are part of the INVITE transaction and have the same CSEQ as invite**
- use pause between sent message to have realistic network delay
- systematically add the rrs=true where needed and the route and Record-Route in te message where it make sense so that scenario work via proxy

WHen writing sipp overall scripts to send sipp trafic, by default:

- don't limit number of total calls
- have logs and error in /tmp tto not pollute the work project directory.

