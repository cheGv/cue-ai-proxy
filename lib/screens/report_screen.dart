import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:http/http.dart' as http;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:supabase_flutter/supabase_flutter.dart';


class ReportScreen extends StatefulWidget {
  final Map<String, dynamic> client;

  const ReportScreen({super.key, required this.client});

  @override
  State<ReportScreen> createState() => _ReportScreenState();
}

class _ReportScreenState extends State<ReportScreen> {
  final _supabase = Supabase.instance.client;

  String _reportType = 'Session Note';
  DateTimeRange? _dateRange;
  final _contextController = TextEditingController();
  final _reportController = TextEditingController();

  bool _isGenerating = false;
  bool _reportReady = false;
  bool _isExporting = false;
  bool _isEditing = false;

  static const _reportTypes = [
    'Session Note',
    'Progress Report',
    'Assessment Report',
    'Discharge Summary',
  ];

  @override
  void dispose() {
    _contextController.dispose();
    _reportController.dispose();
    super.dispose();
  }

  // ── Date helpers ─────────────────────────────────────────────────────────────

  String _fmt(DateTime d) => '${d.day}/${d.month}/${d.year}';

  Future<void> _pickDateRange() async {
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
      initialDateRange: _dateRange,
      builder: (context, child) => Theme(
        data: Theme.of(context).copyWith(
          colorScheme: const ColorScheme.light(
            primary: Colors.teal,
            onPrimary: Colors.white,
            surface: Colors.white,
            onSurface: Colors.black87,
          ),
        ),
        child: child!,
      ),
    );
    if (range != null) setState(() => _dateRange = range);
  }

  // ── Data fetching ────────────────────────────────────────────────────────────

  Future<List<Map<String, dynamic>>> _fetchSessions() async {
    final clientId = widget.client['id'];
    if (_dateRange != null) {
      final from = _dateRange!.start.toIso8601String().substring(0, 10);
      final to = _dateRange!.end.toIso8601String().substring(0, 10);
      final response = await _supabase
          .from('sessions')
          .select()
          .eq('client_id', clientId)
          .gte('date', from)
          .lte('date', to)
          .order('date', ascending: false);
      return List<Map<String, dynamic>>.from(response);
    }
    final response = await _supabase
        .from('sessions')
        .select()
        .eq('client_id', clientId)
        .order('date', ascending: false);
    return List<Map<String, dynamic>>.from(response);
  }

  Future<List<Map<String, dynamic>>> _fetchGoals() async {
    final response = await _supabase
        .from('goals')
        .select()
        .eq('client_id', widget.client['id'])
        .order('created_at', ascending: true);
    return List<Map<String, dynamic>>.from(response);
  }

  // ── Prompt builder ───────────────────────────────────────────────────────────

  String _buildPrompt(
    List<Map<String, dynamic>> sessions,
    List<Map<String, dynamic>> goals,
  ) {
    final client = widget.client;
    final name = client['name'] as String? ?? 'Client';
    final age = client['age']?.toString() ?? 'Not recorded';
    final usesAac = client['uses_aac'] == true;
    final diagnosis = client['diagnosis'] as String? ?? '';

    final sb = StringBuffer();
    sb.writeln('You are an expert Speech-Language Pathologist writing a clinical report.');
    sb.writeln('Write a professional, evidence-based $_reportType for the client below.');
    sb.writeln('Use Australian English spelling and clinical SLP terminology.');
    sb.writeln('The report must be thorough and suitable for NDIS, insurers, schools, or other health professionals.');
    sb.writeln('Use clear headings. Write in full sentences and formal clinical language.');
    sb.writeln('Only include sections where data is available. Do not fabricate or use placeholders.');
    sb.writeln();

    sb.writeln('=== CLIENT INFORMATION ===');
    sb.writeln('Name: $name');
    sb.writeln('Age: $age');
    sb.writeln('AAC User: ${usesAac ? 'Yes' : 'No'}');
    if (diagnosis.isNotEmpty) sb.writeln('Presenting Concerns / Diagnosis: $diagnosis');
    if (_dateRange != null) {
      sb.writeln('Report Period: ${_fmt(_dateRange!.start)} – ${_fmt(_dateRange!.end)}');
    }

    sb.writeln();
    sb.writeln('=== THERAPY GOALS ===');
    if (goals.isEmpty) {
      sb.writeln('No formal goals recorded.');
    } else {
      for (final g in goals) {
        final achieved = g['is_achieved'] == true;
        sb.writeln('${achieved ? '[ACHIEVED]' : '[In Progress]'} ${g['title'] ?? ''}');
        final desc = g['description'] as String? ?? '';
        if (desc.isNotEmpty) sb.writeln('  $desc');
      }
    }

    sb.writeln();
    sb.writeln(
        '=== SESSION DATA (${sessions.length} session${sessions.length == 1 ? '' : 's'}) ===');

    if (sessions.isEmpty) {
      sb.writeln('No sessions recorded in the selected period.');
    } else {
      const levelNames = {
        1: 'Independent',
        2: 'Gesture / Visual',
        3: 'Verbal',
        4: 'Model',
        5: 'Partial Physical',
        6: 'Full Physical',
      };

      for (final s in sessions) {
        sb.writeln();
        sb.writeln('--- Session: ${s['date'] ?? 'Date not recorded'} ---');

        final barriers = <String>[];
        if (s['barrier_motor'] == true) barriers.add('Motor');
        if (s['barrier_linguistic'] == true) barriers.add('Linguistic');
        if (s['barrier_cognitive'] == true) barriers.add('Cognitive');
        if (s['barrier_sensory'] == true) barriers.add('Sensory');
        if (s['barrier_environmental'] == true) barriers.add('Environmental');
        if (s['barrier_motivational'] == true) barriers.add('Motivational');
        if (s['barrier_device_access'] == true) barriers.add('Device Access');
        if (barriers.isNotEmpty) {
          sb.writeln('  Barriers: ${barriers.join(', ')}');
        }

        void note(String label, dynamic value) {
          final str = value?.toString().trim() ?? '';
          if (str.isNotEmpty) sb.writeln('  $label: $str');
        }

        note('Target Behaviour', s['target_behaviour']);
        note('Condition', s['condition']);
        note('Criterion', s['criterion']);
        note('Activity', s['activity_name']);
        note('Activity Rationale', s['activity_rationale']);

        if ((s['prompt_approach'] as String? ?? '').isNotEmpty) {
          final label = s['prompt_approach'] == 'most_to_least'
              ? 'Most to Least'
              : 'Least to Most';
          sb.writeln('  Prompt Approach: $label');
        }

        final level = s['prompt_level_used'] as int?;
        if (level != null) {
          sb.writeln('  Prompt Level: $level – ${levelNames[level] ?? ''}');
        }

        final attempts = s['attempts'] as int?;
        final independent = s['independent_responses'] as int?;
        final prompted = s['prompted_responses'] as int?;

        if (attempts != null || independent != null || prompted != null) {
          sb.writeln(
            '  Trial Data: ${attempts ?? 0} attempts, '
            '${independent ?? 0} independent, ${prompted ?? 0} prompted',
          );
          if ((attempts ?? 0) > 0 && independent != null) {
            final pct = ((independent / attempts!) * 100).round();
            sb.writeln('  Independence Rate: $pct%');
          }
        }

        if ((s['client_affect'] as String? ?? '').isNotEmpty) {
          sb.writeln('  Client Affect: ${s['client_affect']}');
        }

        if ((s['goal_met'] as String? ?? '').isNotEmpty) {
          const goalMetLabels = {
            'yes': 'Yes',
            'partially': 'Partially',
            'not_yet': 'Not Yet',
          };
          sb.writeln('  Goal Met: ${goalMetLabels[s['goal_met']] ?? s['goal_met']}');
        }

        note('Home Programme', s['home_programme']);
        note('Next Session Focus', s['next_session_focus']);
        note('General Notes', s['notes']);
      }
    }

    if (_contextController.text.trim().isNotEmpty) {
      sb.writeln();
      sb.writeln('=== ADDITIONAL CLINICIAN NOTES ===');
      sb.writeln(_contextController.text.trim());
    }

    sb.writeln();
    sb.writeln('=== REPORT FORMAT INSTRUCTIONS ===');

    switch (_reportType) {
      case 'Session Note':
        sb.writeln('Write a clinical session note with these sections:');
        sb.writeln('1. Session Overview');
        sb.writeln('2. Barriers to Participation');
        sb.writeln('3. Intervention Summary (activities and clinical rationale)');
        sb.writeln('4. Prompting Strategy and Client Response');
        sb.writeln('5. Quantitative Trial Data (state independence rate as a percentage)');
        sb.writeln('6. Client Affect and Engagement');
        sb.writeln('7. Goal Progress');
        sb.writeln('8. Home Programme Recommendations');
        sb.writeln('9. Plan for Next Session');
        break;
      case 'Progress Report':
        sb.writeln('Write a clinical progress report with these sections:');
        sb.writeln('1. Referral Information and Background');
        sb.writeln('2. Current Therapy Goals and Status');
        sb.writeln('3. Intervention Approach and Strategies');
        sb.writeln('4. Progress Summary (analyse trends across sessions with data)');
        sb.writeln('5. Barriers Identified and Strategies Implemented');
        sb.writeln('6. Response to Intervention');
        sb.writeln('7. Home Programme Summary');
        sb.writeln('8. Recommendations and Prognosis');
        break;
      case 'Assessment Report':
        sb.writeln('Write a clinical assessment report with these sections:');
        sb.writeln('1. Referral Information');
        sb.writeln('2. Background History');
        sb.writeln('3. Assessment Approach and Methods');
        sb.writeln('4. Clinical Observations');
        sb.writeln('5. Assessment Findings (across relevant communication domains)');
        sb.writeln('6. Barriers Impacting Communication');
        sb.writeln('7. Clinical Impressions');
        sb.writeln('8. AAC Considerations (if applicable)');
        sb.writeln('9. Recommendations');
        sb.writeln('10. Proposed Therapy Goals');
        break;
      case 'Discharge Summary':
        sb.writeln('Write a clinical discharge summary with these sections:');
        sb.writeln('1. Presenting Concerns at Time of Referral');
        sb.writeln('2. Summary of Intervention Provided');
        sb.writeln('3. Goals Achieved');
        sb.writeln('4. Goals Outstanding');
        sb.writeln('5. Progress Summary with Data');
        sb.writeln('6. Reason for Discharge');
        sb.writeln('7. Home Programme to Continue');
        sb.writeln('8. Post-Discharge Recommendations');
        sb.writeln('9. Criteria for Re-referral');
        break;
    }

    sb.writeln();
    sb.writeln(
      'Write the full report now. Be thorough and professional. '
      'Use all available data. Do not invent information not present above.',
    );

    return sb.toString();
  }

  // ── API call ─────────────────────────────────────────────────────────────────

  Future<void> _generateReport() async {
    setState(() {
      _isGenerating = true;
      _reportReady = false;
    });
    try {
      final sessions = await _fetchSessions();
      final goals = await _fetchGoals();
      final prompt = _buildPrompt(sessions, goals);

      final response = await http.post(
        Uri.parse('http://localhost:3001/generate-report'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'model': 'claude-sonnet-4-20250514',
          'max_tokens': 4096,
          'messages': [
            {'role': 'user', 'content': prompt},
          ],
        }),
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        final text =
            ((data['content'] as List).first as Map<String, dynamic>)['text']
                as String;
        setState(() {
          _reportController.text = text;
          _reportReady = true;
          _isEditing = false;
        });
      } else {
        final err = jsonDecode(response.body) as Map<String, dynamic>;
        final msg = (err['error'] as Map<String, dynamic>?)?['message'] ??
            'API error ${response.statusCode}';
        throw Exception(msg);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Error generating report: $e'),
            backgroundColor: Colors.red.shade700,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isGenerating = false);
    }
  }

  // ── PDF export ───────────────────────────────────────────────────────────────

  Future<void> _exportPdf() async {
    setState(() => _isExporting = true);
    try {
      final doc = pw.Document();
      final name = widget.client['name'] as String? ?? 'Client';
      final now = DateTime.now();
      final lines = _reportController.text.split('\n');

      doc.addPage(
        pw.MultiPage(
          pageFormat: PdfPageFormat.a4,
          margin: const pw.EdgeInsets.symmetric(horizontal: 52, vertical: 48),
          header: (ctx) => pw.Column(
            crossAxisAlignment: pw.CrossAxisAlignment.start,
            children: [
              pw.Row(
                mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
                children: [
                  pw.Text(
                    _reportType,
                    style: pw.TextStyle(
                      fontSize: 16,
                      fontWeight: pw.FontWeight.bold,
                      color: PdfColors.teal700,
                    ),
                  ),
                  pw.Text(
                    'Generated ${_fmt(now)}',
                    style: const pw.TextStyle(
                      fontSize: 9,
                      color: PdfColors.grey600,
                    ),
                  ),
                ],
              ),
              pw.Text(
                name,
                style: const pw.TextStyle(
                  fontSize: 11,
                  color: PdfColors.grey700,
                ),
              ),
              pw.SizedBox(height: 6),
              pw.Divider(color: PdfColors.teal700, thickness: 0.5),
              pw.SizedBox(height: 10),
            ],
          ),
          footer: (ctx) => pw.Align(
            alignment: pw.Alignment.centerRight,
            child: pw.Text(
              'Page ${ctx.pageNumber} of ${ctx.pagesCount}',
              style: const pw.TextStyle(
                fontSize: 9,
                color: PdfColors.grey500,
              ),
            ),
          ),
          build: (ctx) {
            final widgets = <pw.Widget>[];
            for (final line in lines) {
              if (line.trim().isEmpty) {
                widgets.add(pw.SizedBox(height: 6));
              } else if (line.startsWith('# ')) {
                widgets.add(pw.Padding(
                  padding: const pw.EdgeInsets.only(top: 14, bottom: 4),
                  child: pw.Text(
                    line.substring(2),
                    style: pw.TextStyle(
                      fontSize: 14,
                      fontWeight: pw.FontWeight.bold,
                      color: PdfColors.teal800,
                    ),
                  ),
                ));
              } else if (line.startsWith('## ')) {
                widgets.add(pw.Padding(
                  padding: const pw.EdgeInsets.only(top: 10, bottom: 3),
                  child: pw.Text(
                    line.substring(3),
                    style: pw.TextStyle(
                      fontSize: 12,
                      fontWeight: pw.FontWeight.bold,
                    ),
                  ),
                ));
              } else if (line.startsWith('### ')) {
                widgets.add(pw.Padding(
                  padding: const pw.EdgeInsets.only(top: 8, bottom: 2),
                  child: pw.Text(
                    line.substring(4),
                    style: pw.TextStyle(
                      fontSize: 11,
                      fontWeight: pw.FontWeight.bold,
                    ),
                  ),
                ));
              } else if (line.startsWith('**') &&
                  line.endsWith('**') &&
                  line.length > 4) {
                widgets.add(pw.Text(
                  line.substring(2, line.length - 2),
                  style: pw.TextStyle(
                    fontSize: 11,
                    fontWeight: pw.FontWeight.bold,
                  ),
                ));
              } else {
                final cleaned =
                    line.replaceFirst(RegExp(r'^[-*•]\s+'), '').trim();
                widgets.add(pw.Text(
                  cleaned,
                  style: const pw.TextStyle(fontSize: 11),
                ));
              }
            }
            return widgets;
          },
        ),
      );

      await Printing.layoutPdf(
        onLayout: (_) async => doc.save(),
        name: '${name}_$_reportType.pdf',
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error exporting PDF: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isExporting = false);
    }
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final client = widget.client;

    return Scaffold(
      appBar: AppBar(
        title: Text('Report – ${client['name']}'),
        backgroundColor: Colors.teal,
        foregroundColor: Colors.white,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Configuration card ──────────────────────────────────────────
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: Colors.grey.shade200),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Report Configuration',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Colors.grey.shade800,
                      ),
                    ),
                    const SizedBox(height: 16),

                    // Report type
                    DropdownButtonFormField<String>(
                      value: _reportType,
                      decoration: _inputDecoration('Report Type'),
                      items: _reportTypes
                          .map((t) =>
                              DropdownMenuItem(value: t, child: Text(t)))
                          .toList(),
                      onChanged: (v) => setState(() => _reportType = v!),
                    ),
                    const SizedBox(height: 14),

                    // Date range
                    GestureDetector(
                      onTap: _pickDateRange,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 14),
                        decoration: BoxDecoration(
                          border: Border.all(color: Colors.grey.shade300),
                          borderRadius: BorderRadius.circular(10),
                          color: Colors.grey.shade50,
                        ),
                        child: Row(
                          children: [
                            Icon(Icons.date_range,
                                color: Colors.teal.shade600, size: 20),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                _dateRange == null
                                    ? 'All sessions (no date filter)'
                                    : '${_fmt(_dateRange!.start)}  →  ${_fmt(_dateRange!.end)}',
                                style: TextStyle(
                                  color: _dateRange == null
                                      ? Colors.grey.shade500
                                      : Colors.grey.shade800,
                                  fontSize: 14,
                                ),
                              ),
                            ),
                            if (_dateRange != null)
                              GestureDetector(
                                onTap: () =>
                                    setState(() => _dateRange = null),
                                child: Icon(Icons.close,
                                    size: 18,
                                    color: Colors.grey.shade400),
                              ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),

                    // Additional context
                    TextField(
                      controller: _contextController,
                      maxLines: 3,
                      decoration: _inputDecoration(
                        'Additional Context (optional)',
                      ).copyWith(
                        hintText:
                            'Extra notes or context to include in the report...',
                      ),
                    ),
                    const SizedBox(height: 20),

                    // Generate button
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: _isGenerating ? null : _generateReport,
                        style: FilledButton.styleFrom(
                          backgroundColor: Colors.teal,
                          disabledBackgroundColor: Colors.teal.shade200,
                          padding:
                              const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                        ),
                        icon: const Icon(Icons.auto_awesome, size: 18),
                        label: const Text(
                          'Generate Report',
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // ── Loading state ───────────────────────────────────────────────
            if (_isGenerating) ...[
              const SizedBox(height: 40),
              Center(
                child: Column(
                  children: [
                    const SizedBox(
                      width: 40,
                      height: 40,
                      child: CircularProgressIndicator(
                        color: Colors.teal,
                        strokeWidth: 3,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'Generating your report…',
                      style: TextStyle(
                        fontSize: 15,
                        color: Colors.grey.shade700,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Analysing session data and clinical notes',
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey.shade400,
                      ),
                    ),
                  ],
                ),
              ),
            ],

            // ── Generated report ────────────────────────────────────────────
            if (_reportReady) ...[
              const SizedBox(height: 28),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Generated Report',
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: Colors.grey.shade800,
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () =>
                        setState(() => _isEditing = !_isEditing),
                    icon: Icon(
                      _isEditing
                          ? Icons.check_rounded
                          : Icons.edit_outlined,
                      size: 16,
                    ),
                    label: Text(_isEditing ? 'Done' : 'Edit'),
                    style: TextButton.styleFrom(
                      foregroundColor: Colors.teal,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Container(
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.teal.shade200),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: _isEditing
                    ? TextField(
                        controller: _reportController,
                        maxLines: null,
                        style: const TextStyle(
                          fontSize: 13,
                          height: 1.65,
                        ),
                        decoration: const InputDecoration(
                          contentPadding: EdgeInsets.all(16),
                          border: InputBorder.none,
                        ),
                      )
                    : Padding(
                        padding: const EdgeInsets.all(16),
                        child: MarkdownBody(
                          data: _reportController.text,
                          selectable: true,
                          styleSheet: MarkdownStyleSheet(
                            h1: TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                              color: Colors.teal.shade800,
                            ),
                            h2: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.bold,
                              color: Colors.grey.shade800,
                            ),
                            h3: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.bold,
                            ),
                            p: const TextStyle(
                              fontSize: 13,
                              height: 1.65,
                            ),
                            listBullet: const TextStyle(
                              fontSize: 13,
                              height: 1.65,
                            ),
                            strong: const TextStyle(
                              fontWeight: FontWeight.bold,
                            ),
                            blockSpacing: 10,
                          ),
                        ),
                      ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _isExporting ? null : _exportPdf,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.teal,
                    side: const BorderSide(color: Colors.teal),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  icon: _isExporting
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                            color: Colors.teal,
                            strokeWidth: 2,
                          ),
                        )
                      : const Icon(Icons.picture_as_pdf_outlined),
                  label: Text(
                    _isExporting ? 'Preparing PDF…' : 'Export as PDF',
                    style: const TextStyle(fontSize: 15),
                  ),
                ),
              ),
              const SizedBox(height: 32),
            ],
          ],
        ),
      ),
    );
  }

  // ── Shared helpers ───────────────────────────────────────────────────────────

  InputDecoration _inputDecoration(String label) {
    return InputDecoration(
      labelText: label,
      filled: true,
      fillColor: Colors.grey.shade50,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.grey.shade300),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: Colors.grey.shade300),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Colors.teal, width: 2),
      ),
    );
  }
}
