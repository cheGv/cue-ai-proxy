import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class GoalsScreen extends StatefulWidget {
  final Map<String, dynamic> client;

  const GoalsScreen({super.key, required this.client});

  @override
  State<GoalsScreen> createState() => _GoalsScreenState();
}

class _GoalsScreenState extends State<GoalsScreen> {
  final _supabase = Supabase.instance.client;
  late Future<List<Map<String, dynamic>>> _goalsFuture;

  @override
  void initState() {
    super.initState();
    _goalsFuture = _fetchGoals();
  }

  Future<List<Map<String, dynamic>>> _fetchGoals() async {
    final response = await _supabase
        .from('goals')
        .select()
        .eq('client_id', widget.client['id'])
        .order('created_at', ascending: true);
    return List<Map<String, dynamic>>.from(response);
  }

  Future<void> _toggleAchieved(String goalId, bool current) async {
    await _supabase
        .from('goals')
        .update({'is_achieved': !current})
        .eq('id', goalId);
    setState(() {
      _goalsFuture = _fetchGoals();
    });
  }

  void _showAddGoalDialog() {
    final titleController = TextEditingController();
    final descController = TextEditingController();

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New Goal'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: titleController,
              decoration: const InputDecoration(labelText: 'Title'),
              textCapitalization: TextCapitalization.sentences,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: descController,
              decoration: const InputDecoration(labelText: 'Description'),
              textCapitalization: TextCapitalization.sentences,
              maxLines: 3,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () async {
              final title = titleController.text.trim();
              if (title.isEmpty) return;
              await _supabase.from('goals').insert({
                'client_id': widget.client['id'],
                'title': title,
                'description': descController.text.trim(),
              });
              if (ctx.mounted) Navigator.pop(ctx);
              setState(() {
                _goalsFuture = _fetchGoals();
              });
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.client['name']}\'s Goals'),
        backgroundColor: Colors.teal,
        foregroundColor: Colors.white,
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _showAddGoalDialog,
        backgroundColor: Colors.teal,
        foregroundColor: Colors.white,
        child: const Icon(Icons.add),
      ),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: _goalsFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snapshot.hasError) {
            return Center(child: Text('Error: ${snapshot.error}'));
          }

          final goals = snapshot.data!;

          if (goals.isEmpty) {
            return const Center(child: Text('No goals yet. Tap + to add one.'));
          }

          return ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: goals.length,
            itemBuilder: (context, index) {
              final goal = goals[index];
              final isAchieved = goal['is_achieved'] == true;

              return Card(
                margin:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                child: CheckboxListTile(
                  value: isAchieved,
                  onChanged: (_) =>
                      _toggleAchieved(goal['id'], isAchieved),
                  activeColor: Colors.teal,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(
                    goal['title'] ?? '',
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 15,
                      decoration:
                          isAchieved ? TextDecoration.lineThrough : null,
                      color: isAchieved ? Colors.grey.shade500 : null,
                    ),
                  ),
                  subtitle: (goal['description'] != null &&
                          (goal['description'] as String).isNotEmpty)
                      ? Text(
                          goal['description'],
                          style: TextStyle(
                            color: isAchieved
                                ? Colors.grey.shade400
                                : Colors.grey.shade600,
                            fontSize: 13,
                          ),
                        )
                      : null,
                ),
              );
            },
          );
        },
      ),
    );
  }
}
