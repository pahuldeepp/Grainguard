#!/usr/bin/env ruby
source = File.read(File.expand_path('../../../..', __dir__) + '/scripts/kafka-topics.mjs')
%w[domainTopics internalTopics].each do |group|
  block = source[/const #{group} = \[\n(.*?)\n\];/m, 1] or abort "missing #{group} inventory"
  block.each_line do |line|
    next if line.strip.empty? || line.lstrip.start_with?('//')
    match = line.match(/^\s*\["([A-Za-z0-9_.-]+)",\s*(\d+)(?:,\s*"(compact|delete)")?(?:,\s*"(\d+)")?\],?\s*(?:\/\/.*)?$/)
    abort "cannot parse #{group} topic: #{line}" unless match
    name, partitions, cleanup, retention = match.captures
    puts [name, partitions, cleanup || (group == 'internalTopics' ? 'compact' : 'delete'), retention || '-'].join('|')
  end
end
