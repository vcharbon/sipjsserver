{{/*
Expand the name of the chart.
*/}}
{{- define "sip-front-proxy.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "sip-front-proxy.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "sip-front-proxy.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "sip-front-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "sip-front-proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sip-front-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "sip-front-proxy.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "sip-front-proxy.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "sip-front-proxy.workerNamespace" -}}
{{- default .Release.Namespace .Values.worker.namespace -}}
{{- end -}}

{{/*
Effective Via "sent-by" host the proxy stamps. Explicit override wins,
otherwise falls back to vip.address when VIP is enabled, otherwise empty
(proxy reverts to its default discovery path). See docs/lb-proxy-ha.md.
*/}}
{{- define "sip-front-proxy.advertisedHost" -}}
{{- if .Values.bind.advertisedHost -}}
{{- .Values.bind.advertisedHost -}}
{{- else if and .Values.vip.enabled .Values.vip.address -}}
{{- .Values.vip.address -}}
{{- end -}}
{{- end -}}

{{/*
Effective bind.host. When VIP is enabled the listener must bind directly
to vip.address — that makes outbound forwarded SIP source-IP'd as the
VIP automatically (kernel uses bound IP as source). When VIP is disabled
we keep the explicit bind.host (default 0.0.0.0).
*/}}
{{- define "sip-front-proxy.bindHost" -}}
{{- if and .Values.vip.enabled .Values.vip.address -}}
{{- .Values.vip.address -}}
{{- else -}}
{{- .Values.bind.host -}}
{{- end -}}
{{- end -}}
